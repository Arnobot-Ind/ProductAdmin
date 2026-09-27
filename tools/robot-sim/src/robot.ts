/**
 * One simulated robot. Physics is deliberately simple: it drives waypoint routes around an origin,
 * battery drains while moving and charges when idle, temperatures follow load. Every message it
 * produces is validated against @arnobot/message-schema before it is queued.
 */
import {
  MESSAGE_FORMAT_VERSION,
  parseRobotMessage,
  type HealthLevel,
  type MissionResult,
} from '@arnobot/message-schema';
import { randomUUID } from 'node:crypto';

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Envelope {
  v: number;
  msg_id: string;
  robot_id: string;
  product: string;
  sw_ver: string;
  fw_ver: string;
  ts: string;
  type: 'hello' | 'live' | 'telemetry' | 'event' | 'mission';
  payload: Record<string, unknown>;
}

const M_PER_DEG_LAT = 111_320;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

interface MissionRun {
  id: string;
  startedAt: Date;
  planned: [number, number][]; // [lon, lat]
  actual: [number, number][];
  target: number;
  distance: number;
  abortAt: number | null; // abort after this many metres (scenario)
}

export class SimRobot {
  lat: number;
  lon: number;
  heading = 0;
  speed = 0;
  battery = 70 + Math.random() * 30;
  tempController = 42;
  tempBattery = 30;
  tempMotors = { left: 35, right: 35 };
  ticks = { left: 0, right: 0 };
  health: Record<'controller' | 'lidar' | 'cameras' | 'gps', HealthLevel> = { controller: 'ok', lidar: 'ok', cameras: 'ok', gps: 'ok' };
  armed = false;
  mode = 'idle';
  swVer = '1.4.0';
  fwVer = '0.9.2';
  mission: MissionRun | null = null;
  missionCounter: number;
  private samples: { gps: object[]; encoders: object[]; battery: object[]; health: object[] } = { gps: [], encoders: [], battery: [], health: [] };
  private readonly bootId = randomUUID();

  constructor(
    readonly robotId: string,
    readonly product: string,
    readonly origin: { lat: number; lon: number },
    private readonly rng: Rng,
    missionCounterStart: number,
  ) {
    this.lat = origin.lat + (rng() - 0.5) * 0.002;
    this.lon = origin.lon + (rng() - 0.5) * 0.002;
    this.missionCounter = missionCounterStart;
  }

  private envelope(type: Envelope['type'], payload: Record<string, unknown>, at: Date): Envelope {
    const env: Envelope = { v: MESSAGE_FORMAT_VERSION, msg_id: randomUUID(), robot_id: this.robotId, product: this.product, sw_ver: this.swVer, fw_ver: this.fwVer, ts: at.toISOString(), type, payload };
    const check = parseRobotMessage(env);
    if (!check.ok) throw new Error(`simulator produced an invalid ${type} message: ${check.error} ${JSON.stringify(check.details)}`);
    return env;
  }

  hello(at: Date): Envelope {
    return this.envelope('hello', {
      boot_id: this.bootId,
      sw_ver: this.swVer,
      fw_ver: this.fwVer,
      enabled_features: ['rtk', 'obstacle_avoidance', 'return_to_home'],
      ips: { lan: '192.168.11.20', omni: '192.168.11.30', tunnel_hostname: `api-${this.robotId}.example.invalid` },
    }, at);
  }

  /** Advances the simulation by dt seconds and records a telemetry sample. */
  step(dtS: number, at: Date): Envelope[] {
    const out: Envelope[] = [];
    const m = this.mission;
    if (m) {
      const [tLon, tLat] = m.planned[m.target];
      const dy = (tLat - this.lat) * M_PER_DEG_LAT;
      const dx = (tLon - this.lon) * M_PER_DEG_LAT * Math.cos((this.lat * Math.PI) / 180);
      const dist = Math.hypot(dx, dy);
      this.speed = 1.2 + this.rng() * 0.3;
      this.heading = (Math.atan2(dx, dy) * 180) / Math.PI;
      const move = Math.min(dist, this.speed * dtS);
      if (dist > 0.01) {
        this.lat += ((dy / dist) * move) / M_PER_DEG_LAT;
        this.lon += ((dx / dist) * move) / (M_PER_DEG_LAT * Math.cos((this.lat * Math.PI) / 180));
      }
      m.distance += move;
      m.actual.push([round(this.lon, 7), round(this.lat, 7)]);
      if (dist - move < 0.5) m.target++;
      const ticks = Math.round(move * 1000);
      this.ticks.left += ticks;
      this.ticks.right += ticks + Math.round((this.rng() - 0.5) * 20);
      this.battery = Math.max(3, this.battery - dtS * 0.02);
      if (m.abortAt !== null && m.distance >= m.abortAt) out.push(...this.endMission(at, 'aborted', 'Operator abort: obstacle blocking path'));
      else if (this.battery < 8) out.push(...this.endMission(at, 'failed', 'Battery critically low'));
      else if (m.target >= m.planned.length) out.push(...this.endMission(at, 'completed', 'All waypoints reached'));
    } else {
      this.speed = 0;
      this.battery = Math.min(100, this.battery + dtS * 0.01);
    }
    const load = this.speed > 0 ? 1 : 0;
    this.tempController += (40 + load * 12 - this.tempController) * 0.05 + (this.rng() - 0.5) * 0.3;
    this.tempBattery += (28 + load * 6 - this.tempBattery) * 0.03;
    this.tempMotors.left += (32 + load * 14 - this.tempMotors.left) * 0.05;
    this.tempMotors.right += (32 + load * 15 - this.tempMotors.right) * 0.05;

    const ts = at.toISOString();
    this.samples.gps.push({ ts, lat: round(this.lat, 7), lon: round(this.lon, 7), alt_m: 53 + round(this.rng(), 1), speed_mps: round(this.speed), heading_deg: round((this.heading + 360) % 360, 1), fix: this.health.gps === 'fault' ? 'none' : 'rtk_fixed' });
    this.samples.encoders.push({ ts, encoder: 'left', ticks: this.ticks.left, velocity_mps: round(this.speed) }, { ts, encoder: 'right', ticks: this.ticks.right, velocity_mps: round(this.speed) });
    this.samples.battery.push({ ts, pct: round(this.battery, 1), voltage_v: round(21 + (this.battery / 100) * 4.2), current_a: round(load * 4 + this.rng()), temp_c: round(this.tempBattery, 1) });
    this.samples.health.push({ ts, ...this.health, temps_c: { controller: round(this.tempController, 1), battery: round(this.tempBattery, 1), motors: { left: round(this.tempMotors.left, 1), right: round(this.tempMotors.right, 1) } } });
    return out;
  }

  live(at: Date): Envelope {
    return this.envelope('live', {
      position: { lat: round(this.lat, 7), lon: round(this.lon, 7), alt_m: 53.2, fix: this.health.gps === 'fault' ? 'none' : 'rtk_fixed', hdop: 0.7, sats: this.health.gps === 'fault' ? 3 : 18, heading_deg: round((this.heading + 360) % 360, 1), speed_mps: round(this.speed) },
      battery: { pct: round(this.battery, 1), voltage_v: round(21 + (this.battery / 100) * 4.2), charging: !this.mission && this.battery < 100 },
      signal_dbm: Math.round(-55 - this.rng() * 30),
      temps_c: { controller: round(this.tempController, 1), battery: round(this.tempBattery, 1), motors: { left: round(this.tempMotors.left, 1), right: round(this.tempMotors.right, 1) } },
      armed: this.armed,
      mode: this.mode,
      health: { ...this.health },
      current_mission_id: this.mission?.id ?? null,
    }, at);
  }

  /** One telemetry batch per interval (spec §7). Each sample keeps its own ts. */
  telemetry(at: Date): Envelope | null {
    if (!this.samples.gps.length) return null;
    const env = this.envelope('telemetry', { ...this.samples }, at);
    this.samples = { gps: [], encoders: [], battery: [], health: [] };
    return env;
  }

  event(at: Date, event_type: string, severity: string, message: string, data?: Record<string, unknown>, code?: string): Envelope {
    return this.envelope('event', { event_type, severity, message, ...(code ? { code } : {}), ...(data ? { data } : {}) }, at);
  }

  /** GCS creates the mission; the robot reports start / end. */
  startMission(at: Date, opts: { abortAfterM?: number } = {}): Envelope[] {
    this.missionCounter++;
    const id = `${this.robotId}-M${String(this.missionCounter).padStart(4, '0')}`;
    const n = 4 + Math.floor(this.rng() * 4);
    const planned: [number, number][] = [[round(this.lon, 7), round(this.lat, 7)]];
    for (let i = 0; i < n; i++) {
      const [pLon, pLat] = planned[planned.length - 1];
      planned.push([round(pLon + (this.rng() - 0.5) * 0.0012, 7), round(pLat + (this.rng() - 0.5) * 0.0012, 7)]);
    }
    this.mission = { id, startedAt: at, planned, actual: [[round(this.lon, 7), round(this.lat, 7)]], target: 1, distance: 0, abortAt: opts.abortAfterM ?? null };
    this.armed = true;
    this.mode = 'auto';
    return [this.envelope('mission', { phase: 'start', mission_id: id, name: `Patrol route ${this.missionCounter}`, started_at: at.toISOString() }, at)];
  }

  lastFinished: { id: string; startedAt: Date; endedAt: Date; planned: [number, number][]; distance: number; result: MissionResult; reason: string } | null = null;

  endMission(at: Date, result: MissionResult, reason: string): Envelope[] {
    const m = this.mission!;
    this.mission = null;
    this.armed = false;
    this.mode = 'idle';
    this.speed = 0;
    this.lastFinished = { id: m.id, startedAt: m.startedAt, endedAt: at, planned: m.planned, distance: m.distance, result, reason };
    const out = [
      this.envelope('mission', {
        phase: 'end',
        mission_id: m.id,
        started_at: m.startedAt.toISOString(),
        ended_at: at.toISOString(),
        distance_m: round(m.distance, 1),
        result,
        end_reason: reason,
        actual_path: { type: 'LineString', coordinates: m.actual.length > 1 ? m.actual : [...m.actual, m.actual[0]] },
        files: [
          { kind: 'video', s3_path: `s3://arnobot-pms/missions/${m.id}/cam1.mp4`, content_type: 'video/mp4' },
          { kind: 'mcap', s3_path: `s3://arnobot-pms/missions/${m.id}/run.mcap` },
        ],
      }, at),
    ];
    if (result !== 'completed') out.push(this.event(at, result === 'aborted' ? 'abort' : 'fault', 'warning', `Mission ${m.id} ${result}: ${reason}`, { mission_id: m.id }));
    return out;
  }

  /** The GCS's own mission report (planned path is authoritative from the GCS). */
  gcsReport(): { missionId: string; body: Record<string, unknown> } | null {
    const f = this.lastFinished;
    if (!f) return null;
    this.lastFinished = null;
    let planned = 0;
    for (let i = 1; i < f.planned.length; i++) {
      const [a, b] = [f.planned[i - 1], f.planned[i]];
      planned += Math.hypot((b[1] - a[1]) * M_PER_DEG_LAT, (b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180));
    }
    return {
      missionId: f.id,
      body: {
        v: 1,
        robot_id: this.robotId,
        external_id: randomUUID(),
        name: `Patrol route ${f.id.split('-M')[1]}`,
        started_at: f.startedAt.toISOString(),
        ended_at: f.endedAt.toISOString(),
        distance_planned_m: round(planned, 1),
        result: f.result,
        end_reason: f.reason,
        planned_path: { type: 'LineString', coordinates: f.planned },
        waypoints_total: f.planned.length - 1,
        waypoints_reached: f.result === 'completed' ? f.planned.length - 1 : Math.max(0, Math.floor((f.planned.length - 1) / 2)),
      },
    };
  }
}
