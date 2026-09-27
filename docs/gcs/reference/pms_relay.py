#!/usr/bin/env python3
"""
Arnobot GCS -> PMS relay (REFERENCE IMPLEMENTATION). See docs/gcs/gcs-integration-checklist.md, Phase 3.

Runs on the GCS (Jetson Orin) as its own container. Reads the GCS database, builds PMS envelopes
(docs/message-contract.md) and pushes them to the PMS ingest service over HTTPS with a durable outbox.

  python pms_relay.py                 # production: reads the GCS Postgres (needs psycopg2)
  python pms_relay.py --fake          # no GCS needed: synthetic robot, for testing against a PMS
  python pms_relay.py --dry-run       # print envelopes, send nothing
  python pms_relay.py --once          # one cycle then exit

Env: PMS_INGEST_URL, PMS_INGEST_KEY (secret: from credential.txt, never in git/compose),
     PMS_ROBOT_ID, PMS_PRODUCT, GCS_SW_VERSION, GCS_FW_VERSION, RELAY_OUTBOX, RELAY_MAX_OUTBOX_GB,
     DB_HOST, DB_NAME, DB_USER, DB_PASSWORD (production source only).

Stdlib only (+ psycopg2 for the real source). Python 3.10+.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

INTERVAL_S = 30          # spec §7: live + telemetry every 30 s
BATCH_MAX = 500          # PMS limit per request
MIN_VALID_YEAR = 2024    # PMS rejects older ts as clock_unsynced

FIX_MAP = {"NO_FIX": "none", "SINGLE": "3d", "DGPS": "dgps", "RTK_FLOAT": "rtk_float", "RTK_FIX": "rtk_fixed", "STALE": "none"}
ALERT_MAP = {  # GCS alert code -> (event_type, severity). Tune with the robot team.
    "GIGA_NOT_CONNECTED": ("fault", "critical"),
    "LIDAR_NOT_AVAILABLE": ("fault", "critical"),
    "NO_GPS": ("fault", "critical"),
    "OVER_TEMPERATURE": ("alert", "warning"),
    "OUT_OF_RANGE": ("alert", "info"),
    "NO_MISSION_SELECTED": ("alert", "info"),
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(msg: str) -> None:
    print(f"{iso(utc_now())} pms_relay {msg}", flush=True)


def clock_synced() -> bool:
    """Checklist 2.3: never capture with an unsynced clock (the Orin has no RTC)."""
    if utc_now().year < MIN_VALID_YEAR:
        return False
    try:
        out = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], capture_output=True, text=True, timeout=3)
        return out.stdout.strip() in ("yes", "")  # "" = not systemd (e.g. container): trust the year check
    except (OSError, subprocess.SubprocessError):
        return True


# ── durable outbox (spec §11) ─────────────────────────────────────────────────
class Outbox:
    def __init__(self, path: str, max_gb: float) -> None:
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS outbox (msg_id TEXT PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS reports (mission_id TEXT PRIMARY KEY, body TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        self.db.commit()
        self.max_bytes = max_gb * 1024 ** 3

    def put(self, env: dict) -> None:
        self.db.execute("INSERT OR IGNORE INTO outbox VALUES (?,?,?,?)", (env["msg_id"], env["ts"], env["type"], json.dumps(env)))
        self.db.commit()
        self._enforce_cap()

    def _enforce_cap(self) -> None:
        # When full, drop the OLDEST TELEMETRY first; events and missions are never dropped.
        size = self.db.execute("SELECT coalesce(sum(length(body)),0) FROM outbox").fetchone()[0]
        while size > self.max_bytes:
            row = self.db.execute("SELECT msg_id, length(body) FROM outbox WHERE type='telemetry' ORDER BY ts LIMIT 1").fetchone()
            if not row:
                break
            self.db.execute("DELETE FROM outbox WHERE msg_id=?", (row[0],))
            size -= row[1]
        self.db.commit()

    def oldest(self, limit: int) -> list[dict]:
        return [json.loads(r[0]) for r in self.db.execute("SELECT body FROM outbox ORDER BY ts, rowid LIMIT ?", (limit,))]

    def remove(self, ids: list[str]) -> None:
        self.db.executemany("DELETE FROM outbox WHERE msg_id=?", [(i,) for i in ids])
        self.db.commit()

    def count(self) -> int:
        return self.db.execute("SELECT count(*) FROM outbox").fetchone()[0]

    def get(self, k: str, default: str | None = None) -> str | None:
        r = self.db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return r[0] if r else default

    def set(self, k: str, v: str) -> None:
        self.db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
        self.db.commit()


# ── PMS client ───────────────────────────────────────────────────────────────
class Pms:
    def __init__(self, url: str, key: str, dry_run: bool) -> None:
        self.url, self.key, self.dry_run = url.rstrip("/"), key, dry_run

    def _post(self, path: str, body) -> tuple[int, dict | None]:
        if self.dry_run:
            print(json.dumps(body, indent=2)[:4000])
            return 200, {"results": [{"msg_id": m["msg_id"], "status": "stored"} for m in body]} if isinstance(body, list) else {}
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": f"Bearer {self.key}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"null")
            except ValueError:
                return e.code, None

    def ingest(self, batch: list[dict]) -> list[dict]:
        status, body = self._post("/api/v1/ingest", batch)
        if status != 200 or not body:
            raise ConnectionError(f"ingest HTTP {status}: {body}")
        return body["results"]

    def report(self, mission_id: str, body: dict) -> int:
        return self._post(f"/api/v1/gcs/missions/{urllib.request.quote(mission_id, safe='')}/report", body)[0]


# ── data sources ─────────────────────────────────────────────────────────────
class FakeSource:
    """Synthetic robot so the relay can be tested without a GCS."""

    def __init__(self) -> None:
        self.lat, self.lon, self.batt, self.t = 23.0225, 72.5714, 90.0, 0

    def snapshot(self) -> dict:
        self.t += 1
        self.lat += 0.00002 * math.sin(self.t / 5)
        self.lon += 0.00002 * math.cos(self.t / 5)
        self.batt = max(5.0, self.batt - 0.05)
        return {"lat": self.lat, "long": self.lon, "altitude": 53.0, "gps_fix": "RTK_FIX", "satellites": 18, "yaw": (self.t * 7) % 360,
                "actual_speed": 1.1, "battery_volt": 21 + self.batt / 100 * 4.2, "battery_pct": self.batt, "armed": True, "mode": "AUTO",
                "return_to_home": False, "cpu_temp_c": 47.5, "health": {"controller": "ok", "lidar": "ok", "gps": "ok"}, "mission_uuid": None,
                "rpm": {"m1": 120, "m2": 118}}

    def alerts(self) -> set[str]:
        return {"OVER_TEMPERATURE"} if self.t % 20 < 3 else set()

    def new_reports(self, _cursor: str | None) -> list[dict]:
        return []


class GcsDbSource:
    """Production source: the GCS Postgres (tables apis_bot, apis_ugvtelemetry, apis_missionreport …)."""

    def __init__(self) -> None:
        import psycopg2  # noqa: PLC0415  (only needed in production)
        self.conn = psycopg2.connect(host=os.environ.get("DB_HOST", "db"), dbname=os.environ.get("DB_NAME", "arnobot_gcs_db"),
                                     user=os.environ.get("DB_USER", "arnobot"), password=os.environ["DB_PASSWORD"])
        self.conn.autocommit = True

    def _one(self, sql: str, params=()) -> dict | None:
        with self.conn.cursor() as c:
            c.execute(sql, params)
            row = c.fetchone()
            return dict(zip([d[0] for d in c.description], row)) if row else None

    def snapshot(self) -> dict:
        bot = self._one("SELECT * FROM apis_bot LIMIT 1") or {}
        tel = self._one("SELECT altitude FROM apis_ugvtelemetry ORDER BY timestamp DESC LIMIT 1") or {}
        try:
            cpu = int(open("/sys/class/thermal/thermal_zone0/temp").read().strip()) / 1000
        except OSError:
            cpu = None
        # TODO(GCS): reuse gcs_data_handler/config.py battery smoothing to compute battery_pct exactly like the UI.
        # TODO(GCS): health from features/get/device_status (controller/lidar/gps) + go2rtc probe for cameras.
        return {**bot, "altitude": tel.get("altitude"), "cpu_temp_c": cpu, "battery_pct": None, "health": {},
                "mission_uuid": str(bot["mission_id"]) if bot.get("mission_id") else None,
                "rpm": {f"m{i}": bot.get(f"rpm_m{i}") for i in range(1, 5) if bot.get(f"rpm_m{i}") is not None}}

    def alerts(self) -> set[str]:
        # TODO(GCS): call http://gcs_data_handler:8080/alerts server-side with GCS_API_TOKEN and return the codes.
        return set()

    def new_reports(self, cursor: str | None) -> list[dict]:
        with self.conn.cursor() as c:
            c.execute("SELECT * FROM apis_missionreport WHERE created_at > coalesce(%s::timestamptz, 'epoch') ORDER BY created_at", (cursor,))
            cols = [d[0] for d in c.description]
            return [dict(zip(cols, r)) for r in c.fetchall()]


# ── relay ────────────────────────────────────────────────────────────────────
class Relay:
    def __init__(self, src, outbox: Outbox, pms: Pms) -> None:
        self.src, self.outbox, self.pms = src, outbox, pms
        self.robot_id = os.environ["PMS_ROBOT_ID"]
        self.product = os.environ.get("PMS_PRODUCT", "saibya")
        self.sw, self.fw = os.environ.get("GCS_SW_VERSION", "0.0.0"), os.environ.get("GCS_FW_VERSION", "0.0.0")
        self.samples: dict[str, list] = {"gps": [], "encoders": [], "battery": [], "health": []}
        self.active_alerts: set[str] = set()
        self.link_was_down = False
        self.backoff = 5
        self._last: dict | None = None

    def env(self, typ: str, payload: dict, ts: datetime | None = None) -> dict:
        return {"v": 1, "msg_id": str(uuid.uuid4()), "robot_id": self.robot_id, "product": self.product,
                "sw_ver": self.sw, "fw_ver": self.fw, "ts": iso(ts or utc_now()), "type": typ, "payload": payload}

    def pms_mission_id(self, gcs_uuid: str) -> str:
        key = f"mission:{gcs_uuid}"
        mid = self.outbox.get(key)
        if not mid:
            n = int(self.outbox.get("mission_counter", "0")) + 1
            self.outbox.set("mission_counter", str(n))
            mid = f"{self.robot_id}-M{n:04d}"
            self.outbox.set(key, mid)
        return mid

    def hello(self) -> None:
        self.outbox.put(self.env("hello", {"sw_ver": self.sw, "fw_ver": self.fw, "enabled_features": [], "ips": {}}))

    def live_payload(self, s: dict) -> dict:
        p: dict = {}
        if s.get("lat") is not None and s.get("long") is not None:
            p["position"] = {"lat": float(s["lat"]), "lon": float(s["long"]), "fix": FIX_MAP.get(str(s.get("gps_fix", "")).upper(), "none")}
            for k, dst in (("altitude", "alt_m"), ("satellites", "sats"), ("actual_speed", "speed_mps")):
                if s.get(k) is not None:
                    p["position"][dst] = s[k] if dst == "sats" else float(s[k])
            if s.get("yaw") is not None:
                p["position"]["heading_deg"] = float(s["yaw"]) % 360
        batt = {k: v for k, v in (("voltage_v", s.get("battery_volt")), ("pct", s.get("battery_pct"))) if v is not None}
        if batt:
            p["battery"] = {k: round(float(v), 2) for k, v in batt.items()}
        if s.get("cpu_temp_c") is not None:
            p["temps_c"] = {"controller": round(float(s["cpu_temp_c"]), 1)}
        if s.get("armed") is not None:
            p["armed"] = bool(s["armed"])
        if s.get("mode"):
            p["mode"] = "rth" if s.get("return_to_home") else str(s["mode"]).lower()
        if s.get("health"):
            p["health"] = s["health"]
        p["current_mission_id"] = self.pms_mission_id(s["mission_uuid"]) if s.get("mission_uuid") else None
        return p

    def sample(self) -> None:
        s = self.src.snapshot()
        ts = iso(utc_now())
        if s.get("lat") is not None and s.get("long") is not None:
            self.samples["gps"].append({"ts": ts, "lat": float(s["lat"]), "lon": float(s["long"]), "fix": FIX_MAP.get(str(s.get("gps_fix", "")).upper(), "none")})
        for name, rpm in (s.get("rpm") or {}).items():
            self.samples["encoders"].append({"ts": ts, "encoder": name, "rpm": float(rpm)})
        if s.get("battery_volt") is not None:
            self.samples["battery"].append({"ts": ts, "voltage_v": round(float(s["battery_volt"]), 2), **({"pct": round(float(s["battery_pct"]), 1)} if s.get("battery_pct") is not None else {})})
        # alert edge detection (alerts are computed per poll in the GCS and never stored)
        now_alerts = self.src.alerts()
        for code in sorted(now_alerts - self.active_alerts):
            etype, sev = ALERT_MAP.get(code, ("alert", "warning"))
            self.outbox.put(self.env("event", {"event_type": etype, "severity": sev, "code": code, "message": code.replace("_", " ").capitalize()}))
        for code in sorted(self.active_alerts - now_alerts):
            self.outbox.put(self.env("event", {"event_type": "alert", "severity": "info", "code": f"{code}_CLEARED", "message": f"{code} cleared"}))
        self.active_alerts = now_alerts
        self._last = s

    def cycle(self) -> None:
        s = self._last or self.src.snapshot()
        self.outbox.put(self.env("live", self.live_payload(s)))
        if any(self.samples.values()):
            self.outbox.put(self.env("telemetry", {k: v for k, v in self.samples.items() if v}))
            self.samples = {k: [] for k in self.samples}
        for rep in self.src.new_reports(self.outbox.get("report_cursor")):
            self.queue_report(rep)
            self.outbox.set("report_cursor", rep["created_at"].isoformat())
        self.flush()

    def queue_report(self, r: dict) -> None:
        mid = self.pms_mission_id(str(r["mission_id"]))
        data = r.get("report_data") or {}
        planned = [[w["lng"], w["lat"]] for w in data.get("waypoints", []) if w.get("lat") is not None]
        track = [[p["lon"], p["lat"]] for p in data.get("track", []) if p.get("lat") is not None]
        result = r.get("status") if r.get("status") in ("completed", "aborted", "failed") else "failed"
        end = {"phase": "end", "mission_id": mid, "started_at": iso(r["started_at"]), "ended_at": iso(r["ended_at"]),
               "result": result, "end_reason": data.get("notes") or result}
        if len(track) >= 2:
            end["actual_path"] = {"type": "LineString", "coordinates": track}
        self.outbox.put(self.env("mission", end, r["ended_at"]))
        report = {"v": 1, "robot_id": self.robot_id, "external_id": str(r["mission_id"]), "name": r.get("mission_name"),
                  "started_at": iso(r["started_at"]), "ended_at": iso(r["ended_at"]), "result": result,
                  "distance_planned_m": r.get("distance_planned_m"), "waypoints_total": r.get("waypoints_total"),
                  "waypoints_reached": r.get("waypoints_reached")}
        if len(planned) >= 2:
            report["planned_path"] = {"type": "LineString", "coordinates": planned}
        self.outbox.db.execute("INSERT OR REPLACE INTO reports VALUES (?,?)", (mid, json.dumps({k: v for k, v in report.items() if v is not None})))
        self.outbox.db.commit()

    def flush(self) -> None:
        try:
            if self.link_was_down:
                # spec §11: CURRENT live first so the console is right at once, then the backlog oldest-first
                live = self.env("live", self.live_payload(self._last or self.src.snapshot()))
                self.handle([live], self.pms.ingest([live]))
                self.hello_after_reconnect()
                self.link_was_down = False
            while True:
                batch = self.outbox.oldest(BATCH_MAX)
                if not batch:
                    break
                results = self.pms.ingest(batch)
                self.handle(batch, results)
                if any(r["status"] == "rejected" and r.get("retryable") for r in results):
                    raise ConnectionError("PMS asked to retry later")
            for mid, body in list(self.outbox.db.execute("SELECT mission_id, body FROM reports")):
                code = self.pms.report(mid, json.loads(body))
                if code in (200, 201) or 400 <= code < 500 and code not in (401, 429):
                    self.outbox.db.execute("DELETE FROM reports WHERE mission_id=?", (mid,))
                    self.outbox.db.commit()
                log(f"mission report {mid} -> HTTP {code}")
            self.backoff = 5
        except (ConnectionError, urllib.error.URLError, OSError) as e:
            self.link_was_down = True
            log(f"PMS unreachable ({e}); {self.outbox.count()} message(s) kept; retry in {self.backoff}s")
            time.sleep(self.backoff)
            self.backoff = min(300, self.backoff * 2)

    def hello_after_reconnect(self) -> None:
        self.hello()

    def handle(self, batch: list[dict], results: list[dict]) -> None:
        done = []
        for m, r in zip(batch, results):
            if r["status"] in ("stored", "duplicate"):
                done.append(m["msg_id"])
            elif r["status"] == "rejected" and not r.get("retryable"):
                done.append(m["msg_id"])
                log(f"rejected {m['type']} {m['msg_id']}: {r.get('error')} (dropped; PMS kept a copy)")
        self.outbox.remove(done)


def main() -> None:
    ap = argparse.ArgumentParser(description="Arnobot GCS -> PMS relay")
    ap.add_argument("--fake", action="store_true", help="synthetic robot (no GCS needed)")
    ap.add_argument("--dry-run", action="store_true", help="print envelopes, send nothing")
    ap.add_argument("--once", action="store_true", help="run one cycle and exit")
    ap.add_argument("--interval", type=float, default=INTERVAL_S)
    a = ap.parse_args()
    for var in ("PMS_INGEST_URL", "PMS_ROBOT_ID") + (() if a.dry_run else ("PMS_INGEST_KEY",)):
        if not os.environ.get(var):
            sys.exit(f"missing env {var}")
    while not clock_synced():
        log("waiting for NTP clock sync before capturing data (checklist 2.3)")
        time.sleep(10)
    outbox = Outbox(os.environ.get("RELAY_OUTBOX", "outbox.sqlite"), float(os.environ.get("RELAY_MAX_OUTBOX_GB", "75")))
    relay = Relay(FakeSource() if a.fake else GcsDbSource(), outbox,
                  Pms(os.environ["PMS_INGEST_URL"], os.environ.get("PMS_INGEST_KEY", ""), a.dry_run))
    relay.hello()
    log(f"started for {relay.robot_id} -> {os.environ['PMS_INGEST_URL']} (outbox {outbox.count()})")
    samples_per_cycle = 10
    while True:
        for _ in range(samples_per_cycle):
            relay.sample()
            if not a.once:
                time.sleep(a.interval / samples_per_cycle)
        relay.cycle()
        log(f"cycle done; outbox {outbox.count()}")
        if a.once:
            break


if __name__ == "__main__":
    random.seed()
    main()
