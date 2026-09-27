#!/usr/bin/env node
/**
 * Arnobot robot + GCS simulator. Real robots are not online yet; this speaks the exact contract.
 *
 *   npm run sim -- [--robots saibya01,altius01|all] [--scenario normal|flaky|offline-backlog|duplicate|fault|version-bump|mission|mixed]
 *                  [--speed 10] [--duration 600] [--seed 42] [--ingest http://localhost:4100] [--once]
 *
 * Behaves like the real robot is required to (spec §11): every message goes to a local OUTBOX first;
 * it is removed only when the PMS answers `stored` or `duplicate`. After a reconnect, the CURRENT live
 * state is sent first, then the backlog oldest-first.
 */
import { REPORT_INTERVAL_MS } from '@arnobot/message-schema';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulberry32, SimRobot, type Envelope } from './robot';

type Scenario = 'normal' | 'flaky' | 'offline-backlog' | 'duplicate' | 'fault' | 'version-bump' | 'mission' | 'mixed';
const SCENARIOS: Scenario[] = ['normal', 'flaky', 'offline-backlog', 'duplicate', 'fault', 'version-bump', 'mission', 'mixed'];

const ROOT = resolve(__dirname, '..', '..', '..');
const KEYS_PATH = resolve(ROOT, '.sim-keys.json');
const STATE_PATH = resolve(ROOT, '.sim-state.json');
const ORIGINS: Record<string, { lat: number; lon: number }> = {
  saibya: { lat: 23.0225, lon: 72.5714 }, // Ahmedabad
  altius: { lat: 23.2156, lon: 72.6369 }, // Gandhinagar
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Keys {
  ingest_url: string;
  robots: Record<string, { product: string; key: string }>;
  gcs?: { key: string };
}

const log = (robot: string, msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${robot.padEnd(10)} ${msg}`);

class Link {
  outbox: Envelope[] = [];
  sentOk: Envelope[] = [];
  up = true;
  reconnected = false;
  gcsPending: { missionId: string; body: Record<string, unknown> }[] = [];

  constructor(
    private readonly robotId: string,
    private readonly ingestUrl: string,
    private readonly key: string,
    private readonly gcsKey: string | undefined,
  ) {}

  setUp(up: boolean): void {
    if (up && !this.up) this.reconnected = true;
    this.up = up;
  }

  private async post(batch: Envelope[]): Promise<{ msg_id: string; status: string; error?: string; retryable?: boolean }[]> {
    const res = await fetch(`${this.ingestUrl}/api/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { results: { msg_id: string; status: string; error?: string; retryable?: boolean }[] }).results;
  }

  async flush(currentLive: () => Envelope, resendDuplicates = false): Promise<void> {
    if (!this.up) return;
    try {
      if (this.reconnected) {
        // Spec §11: current live state FIRST so the console is right at once; backlog follows.
        this.reconnected = false;
        const backlog = this.outbox.length;
        // Old buffered live messages are still uploaded (history), but can't rewind live_state (rule 7).
        const live = currentLive();
        await this.handle([live], await this.post([live]));
        log(this.robotId, `reconnected: sent current live first, now replaying ${backlog} buffered message(s) oldest-first`);
      }
      this.outbox.sort((a, b) => a.ts.localeCompare(b.ts));
      while (this.outbox.length) {
        const batch = this.outbox.slice(0, 100);
        const results = await this.post(batch);
        await this.handle(batch, results);
        if (results.some((r) => r.status === 'rejected' && r.retryable)) break;
      }
      if (resendDuplicates && this.sentOk.length) {
        const again = this.sentOk.slice(-5);
        const results = await this.post(again);
        log(this.robotId, `re-sent ${again.length} already-stored message(s) → ${results.map((r) => r.status).join(', ')}`);
      }
      for (const report of [...this.gcsPending]) {
        if (!this.gcsKey) break;
        const res = await fetch(`${this.ingestUrl}/api/v1/gcs/missions/${encodeURIComponent(report.missionId)}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.gcsKey}` },
          body: JSON.stringify(report.body),
        });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) this.gcsPending.shift();
        log(this.robotId, `GCS report ${report.missionId} → HTTP ${res.status}`);
      }
    } catch (err) {
      log(this.robotId, `send failed (${(err as Error).message}); keeping ${this.outbox.length} message(s) in the outbox`);
    }
  }

  private async handle(batch: Envelope[], results: { msg_id: string; status: string; error?: string; retryable?: boolean }[]): Promise<void> {
    const done = new Set<string>();
    results.forEach((r, i) => {
      const m = batch[i];
      if (r.status === 'stored' || r.status === 'duplicate') {
        done.add(m.msg_id);
        this.sentOk.push(m);
        if (this.sentOk.length > 50) this.sentOk.shift();
      } else if (r.status === 'rejected' && !r.retryable) {
        done.add(m.msg_id);
        log(this.robotId, `✗ ${m.type} rejected: ${r.error} (dropped, PMS kept a copy)`);
      }
    });
    this.outbox = this.outbox.filter((m) => !done.has(m.msg_id));
  }
}

async function main(): Promise<void> {
  if (flag('help')) {
    console.log(readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  if (!existsSync(KEYS_PATH)) throw new Error(`${KEYS_PATH} not found; run "npm run db:seed" first (SEED_DEMO_ROBOTS=true)`);
  const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as Keys;
  const ingestUrl = (arg('ingest') ?? keys.ingest_url ?? 'http://localhost:4100').replace(/\/$/, '');
  const scenario = (arg('scenario', 'normal') as Scenario) ?? 'normal';
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario; use one of ${SCENARIOS.join(', ')}`);
  const speed = Math.max(0.1, Number(arg('speed', '1')));
  const durationS = Number(arg('duration', '0'));
  const once = flag('once');
  const seed = Number(arg('seed', String(Date.now() % 100000)));
  const which = arg('robots', 'all')!;
  const robotIds = which === 'all' ? Object.keys(keys.robots) : which.split(',').map((s) => s.trim());
  const state = (existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}) as Record<string, number>;

  const intervalMs = REPORT_INTERVAL_MS / speed;
  const SAMPLES = 10;
  console.log(`robot-sim → ${ingestUrl} · scenario=${scenario} · robots=${robotIds.join(',')} · every ${(intervalMs / 1000).toFixed(1)} s · seed=${seed}`);

  const sims = robotIds.map((id, i) => {
    const k = keys.robots[id];
    if (!k) throw new Error(`no key for ${id} in .sim-keys.json`);
    const rng = mulberry32(seed + i * 7919);
    const robot = new SimRobot(id, k.product, ORIGINS[k.product] ?? ORIGINS.saibya, rng, state[id] ?? 0);
    const sc: Scenario = scenario === 'mixed' ? (['normal', 'fault', 'mission', 'flaky', 'version-bump'] as Scenario[])[i % 5] : scenario;
    return { robot, rng, link: new Link(id, ingestUrl, k.key, keys.gcs?.key), scenario: sc, tick: 0 };
  });

  for (const s of sims) {
    s.link.outbox.push(s.robot.hello(new Date()));
    log(s.robot.robotId, `boot → hello (scenario ${s.scenario})`);
  }

  const started = Date.now();
  const cycle = async () => {
    await Promise.all(
      sims.map(async (s) => {
        const { robot, link, rng } = s;
        s.tick++;
        const end = new Date();
        // physics + samples spread over the interval that just elapsed
        for (let i = SAMPLES - 1; i >= 0; i--) {
          const at = new Date(end.getTime() - (i * intervalMs) / SAMPLES);
          for (const m of robot.step((REPORT_INTERVAL_MS / 1000 / SAMPLES), at)) {
            link.outbox.push(m);
            if (m.type === 'mission') log(robot.robotId, `mission ${String((m.payload as { mission_id: string }).mission_id)} ended`);
          }
        }
        const now = new Date();

        // ── scenarios ─────────────────────────────────────────────────────
        if (s.scenario === 'fault' && s.tick === 3) {
          robot.health.lidar = 'fault';
          link.outbox.push(robot.event(now, 'fault', 'critical', 'LiDAR not responding', { device: 'lidar' }, 'LIDAR_NOT_AVAILABLE'));
          log(robot.robotId, 'FAULT: LiDAR → fault + critical event');
        }
        if (s.scenario === 'fault' && s.tick === 10) {
          robot.health.lidar = 'ok';
          link.outbox.push(robot.event(now, 'alert', 'info', 'LiDAR recovered', { device: 'lidar' }));
          log(robot.robotId, 'LiDAR recovered');
        }
        if (s.scenario === 'fault' && s.tick === 6) robot.health.cameras = 'warning';
        if (s.scenario === 'version-bump' && s.tick === 4) {
          robot.swVer = '1.5.0';
          link.outbox.push(robot.event(now, 'update', 'info', 'Software updated 1.4.0 → 1.5.0'));
          link.outbox.push(robot.hello(now));
          log(robot.robotId, 'reboot with sw 1.5.0 → hello');
        }
        if (s.scenario === 'offline-backlog') {
          const offFrom = 2;
          const offFor = Number(arg('offline-intervals', '12'));
          if (s.tick === offFrom) {
            link.setUp(false);
            log(robot.robotId, `network DOWN for ${offFor} intervals — buffering locally`);
          }
          if (s.tick === offFrom + offFor) link.setUp(true);
        }
        if (s.scenario === 'flaky') {
          if (link.up && rng() < 0.2) {
            link.setUp(false);
            log(robot.robotId, 'link dropped');
          } else if (!link.up && rng() < 0.4) link.setUp(true);
        }
        if (!robot.mission && (s.scenario === 'mission' ? s.tick % 3 === 1 : s.tick % 6 === 2) && robot.battery > 25) {
          const abort = s.scenario === 'mission' && rng() < 0.5 ? 60 + rng() * 80 : undefined;
          link.outbox.push(...robot.startMission(now, { abortAfterM: abort }));
          state[robot.robotId] = robot.missionCounter;
          writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
          log(robot.robotId, `mission ${robot.mission!.id} started${abort ? ' (will abort)' : ''}`);
        }

        link.outbox.push(robot.live(now));
        const tel = robot.telemetry(now);
        if (tel) link.outbox.push(tel);
        const report = robot.gcsReport();
        if (report) link.gcsPending.push(report);

        await link.flush(() => robot.live(new Date()), s.scenario === 'duplicate' && s.tick % 2 === 0);
        log(robot.robotId, `${link.up ? 'up  ' : 'DOWN'} battery ${robot.battery.toFixed(0)}% · outbox ${link.outbox.length}${robot.mission ? ` · ${robot.mission.id}` : ''}`);
      }),
    );
  };

  await cycle();
  if (once) return;
  const timer = setInterval(() => {
    if (durationS && Date.now() - started > durationS * 1000) {
      clearInterval(timer);
      console.log('duration reached; stopping');
      return;
    }
    void cycle();
  }, intervalMs);
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\nstopped');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
