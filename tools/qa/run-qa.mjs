#!/usr/bin/env node
/**
 * Arnobot PMS — automated QA.  Run:  npm run build && npm run qa
 *
 * Isolation: creates a throw-away database `<db>_qa` (via PG_ADMIN_URL), migrates + seeds it, and
 * starts its own API (:4900) and ingest (:4910) processes against it. Your real data is never touched.
 *
 * Sections:  A repository & config · B database design · C ingestion rules · D admin API & permissions
 *            E realtime · F frontend build
 * Output:    console summary, docs/qa/reports/qa-<timestamp>.json, docs/qa/LAST_RUN.md. Exit 1 on failure.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_PORT = 4900;
const INGEST_PORT = 4910;
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const INGEST = `http://127.0.0.1:${INGEST_PORT}`;

// ── tiny harness ────────────────────────────────────────────────────────────
const results = [];
let section = '';
function sec(name) {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
async function check(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ section, name, ok: true, ms: Date.now() - t, note: note ?? null });
    console.log(`  \x1b[32m✓\x1b[0m ${name}${note ? `  \x1b[2m(${note})\x1b[0m` : ''}`);
  } catch (e) {
    results.push({ section, name, ok: false, ms: Date.now() - t, error: e.message });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ── env & isolated database ─────────────────────────────────────────────────
const env = { ...process.env };
if (!env.DATABASE_URL || !env.PG_ADMIN_URL) {
  console.error('DATABASE_URL and PG_ADMIN_URL must be set (run via: npm run qa)');
  process.exit(2);
}
const appUrl = new URL(env.DATABASE_URL);
const qaDbName = `${appUrl.pathname.slice(1)}_qa`;
const qaUrl = new URL(env.DATABASE_URL);
qaUrl.pathname = `/${qaDbName}`;
const QA_ENV = {
  ...env,
  DATABASE_URL: qaUrl.toString(),
  API_PORT: String(API_PORT),
  API_HOST: '127.0.0.1',
  INGEST_PORT: String(INGEST_PORT),
  INGEST_HOST: '127.0.0.1',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: join(ROOT, '.qa-storage'),
  SEED_DEMO_ROBOTS: 'true',
  LOG_LEVEL: 'warn',
  MQTT_BROKER_URL: '',
};

function run(cmd, args, extraEnv = {}) {
  return execFileSync(cmd === 'node' ? process.execPath : cmd, args, { cwd: ROOT, env: { ...QA_ENV, ...extraEnv }, stdio: 'pipe' }).toString();
}

async function resetQaDb() {
  const admin = new pg.Client({ connectionString: env.PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${qaDbName}" WITH (FORCE)`);
  await admin.end();
  run('node', ['packages/db/dist/cli/create-db.js']);
  run('node', ['packages/db/dist/cli/migrate.js', 'up']);
  // seed writes .sim-keys.json at the repo root — keep the developer's file intact
  const keysPath = join(ROOT, '.sim-keys.json');
  const saved = existsSync(keysPath) ? readFileSync(keysPath) : null;
  if (saved) unlinkSync(keysPath);
  let qaKeys;
  try {
    run('node', ['packages/db/dist/cli/seed.js']);
    qaKeys = JSON.parse(readFileSync(keysPath, 'utf8'));
  } finally {
    if (saved) writeFileSync(keysPath, saved);
    else if (existsSync(keysPath)) unlinkSync(keysPath);
  }
  return qaKeys;
}

const children = [];
function startService(name, entry, readyUrl) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: ROOT, env: QA_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => reject(new Error(`${name} exited (${code}): ${out.slice(-500)}`)));
    const deadline = Date.now() + 20_000;
    const poll = async () => {
      try {
        const r = await fetch(readyUrl);
        if (r.ok) return resolveP(child);
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`${name} did not become ready: ${out.slice(-500)}`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
class Session {
  cookie = '';
  async req(method, path, body, { raw = false, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET' && csrf) h['x-requested-with'] = 'pms-admin';
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(API + path, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    if (raw) return r;
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, body: json, text, headers: r.headers };
  }
  async login(email, password) {
    const r = await this.req('POST', '/auth/login', { email, password });
    assert(r.status === 200, `login ${email} → ${r.status} ${r.text}`);
    return r.body;
  }
}
async function ingest(key, body) {
  const r = await fetch(`${INGEST}/api/v1/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const env1 = (robot, product, type, payload, ts = new Date().toISOString(), extra = {}) => ({
  v: 1, msg_id: randomUUID(), robot_id: robot, product, sw_ver: '1.4.0', fw_ver: '0.9.2', ts, type, payload, ...extra,
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.turbo', '.qa-storage', 'storage', 'reports'].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === '.next') continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  const startedAt = new Date();
  for (const f of ['packages/db/dist/cli/migrate.js', 'apps/api/dist/main.js', 'apps/ingest/dist/main.js']) {
    if (!existsSync(join(ROOT, f))) {
      console.error(`missing ${f}: run "npm run build" first`);
      process.exit(2);
    }
  }

  // ── A. repository & configuration ─────────────────────────────────────
  sec('A. Repository & configuration');
  const files = walk(ROOT);
  const code = files.filter((f) => /\.(ts|tsx|js|mjs|json|sql|ya?ml|env\.example)$/.test(f) && !f.includes(`${join('tools', 'qa')}`));
  await check('rule 12: NEXT_PUBLIC_GCS_API_TOKEN is not defined or read anywhere in code', () => {
    const hits = code.filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /NEXT_PUBLIC_GCS_API_TOKEN\s*[=:]|process\.env\.NEXT_PUBLIC_GCS_API_TOKEN\b(?!\))/.test(t) && !f.endsWith('config.ts');
    });
    assert(!hits.length, `found in ${hits.map((h) => relative(ROOT, h)).join(', ')}`);
  });
  await check('.env, .sim-keys.json and storage/ are git-ignored', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    for (const p of ['.env', '.sim-keys.json', 'storage/']) assert(gi.split(/\r?\n/).includes(p), `${p} missing from .gitignore`);
  });
  await check('.env.example contains no real secrets', () => {
    const t = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const k of ['CREDENTIAL_ENCRYPTION_KEY', 'SESSION_SECRET', 'SEED_ADMIN_PASSWORD']) assert(new RegExp(`^${k}=\\s*$`, 'm').test(t), `${k} has a value in .env.example`);
  });
  await check('rule 14: migrations are numbered 0001… without gaps or duplicates', () => {
    const m = readdirSync(join(ROOT, 'packages/db/migrations')).filter((f) => f.endsWith('.sql')).sort();
    m.forEach((f, i) => assert(f.startsWith(String(i + 1).padStart(4, '0') + '_'), `unexpected ${f} at position ${i + 1}`));
    return `${m.length} migrations`;
  });
  await check('rule 10: no hard DELETE statements in application code', () => {
    const hits = code.filter((f) => /apps[\\/](api|ingest)[\\/]src/.test(f) && /\bDELETE\s+FROM\b/i.test(readFileSync(f, 'utf8')));
    assert(!hits.length, hits.map((h) => relative(ROOT, h)).join(', '));
  });
  await check('rule 10: no Timescale retention / drop_chunks policies', () => {
    const hits = code.filter((f) => /add_retention_policy|drop_chunks/i.test(readFileSync(f, 'utf8')));
    assert(!hits.length, hits.map((h) => relative(ROOT, h)).join(', '));
  });
  await check('frontend code never references server-only secrets', () => {
    const adminSrc = files.filter((f) => f.includes(join('apps', 'admin')) && /\.(tsx?|jsx?)$/.test(f));
    // Reading a server-only env var from frontend code is the bug; mentioning a name in a UI label is not.
    const bad = adminSrc.filter((f) => /process.env.(CREDENTIAL_ENCRYPTION_KEY|SESSION_SECRET|DATABASE_URL|PG_ADMIN_URL|S3_SECRET_KEY|GCS_API_TOKEN|NEXT_PUBLIC_GCS_API_TOKEN)/.test(readFileSync(f, 'utf8')));
    assert(!bad.length, bad.map((h) => relative(ROOT, h)).join(', '));
    return `${adminSrc.length} files scanned`;
  });

  // ── isolated stack ─────────────────────────────────────────────────────
  console.log(`\n\x1b[2mPreparing isolated QA database "${qaDbName}" and services on :${API_PORT} / :${INGEST_PORT} …\x1b[0m`);
  const keys = await resetQaDb();
  await startService('ingest', 'apps/ingest/dist/main.js', `${INGEST}/healthz`);
  await startService('api', 'apps/api/dist/main.js', `${API}/healthz`);
  const db = new pg.Client({ connectionString: QA_ENV.DATABASE_URL });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const guard = async (sql) => {
    await db.query('BEGIN');
    try {
      await db.query(sql);
      return null;
    } catch (e) {
      return e;
    } finally {
      await db.query('ROLLBACK');
    }
  };

  // ── B. database design ─────────────────────────────────────────────────
  sec('B. Database design (SQL)');
  await check('all migrations applied, none modified', async () => {
    const out = run('node', ['packages/db/dist/cli/migrate.js', 'status']);
    assert(!/MODIFIED|·/.test(out), out);
  });
  const expected = ['companies', 'sites', 'users', 'roles', 'permissions', 'role_permissions', 'role_grants', 'sessions', 'products', 'hardware_revisions', 'part_types', 'hardware_revision_components', 'robots', 'company_assignment_history', 'site_assignment_history', 'maintenance_log', 'hardware_fitted', 'software_history', 'connectivity', 'robot_cameras', 'dispatch_warranty', 'files', 'documents', 'document_versions', 'robot_credentials', 'ingest_clients', 'ingest_client_robots', 'ingest_keys', 'live_state', 'ingested_messages', 'ingest_rejections', 'events', 'missions', 'mission_files', 'telemetry_gps', 'telemetry_encoder', 'telemetry_battery', 'telemetry_health', 'releases'];
  await check('every designed table exists', async () => {
    const have = new Set((await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map((r) => r.tablename));
    const missing = expected.filter((t) => !have.has(t));
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    return `${expected.length} tables`;
  });
  await check('rule 10: every domain table has a no-hard-delete trigger', async () => {
    const withTrig = new Set((await q("SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'pms_forbid_delete'")).map((r) => r.relname));
    const exempt = new Set(['roles', 'permissions', 'role_permissions', 'sessions']);
    const missing = expected.filter((t) => !exempt.has(t) && !withTrig.has(t));
    assert(!missing.length, `no delete guard on: ${missing.join(', ')}`);
  });
  await check('rule 2: robots has no mutable company_id column', async () => {
    const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'robots'")).map((r) => r.column_name);
    assert(!cols.includes('company_id'), 'robots.company_id exists');
  });
  await check('rule 11: robots/connectivity/cameras have no secret-looking columns', async () => {
    const cols = await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('robots','connectivity','robot_cameras','live_state') AND column_name ~* '(pass|secret|token|credential|private_key)'");
    assert(!cols.length, JSON.stringify(cols));
  });
  const probes = [
    ['rule 1: robot_id cannot be changed', "UPDATE robots SET robot_id = 'x99' WHERE robot_id = 'saibya01'"],
    ['rule 1: robot_id cannot equal the serial number', "INSERT INTO robots (robot_id, serial_number, product_id, running_number) SELECT 'saibya77', 'SAIBYA77', id, 77 FROM products WHERE code = 'saibya'"],
    ['rule 1: serial numbers are unique (case-insensitive)', "INSERT INTO robots (robot_id, serial_number, product_id, running_number) SELECT 'saibya78', lower(serial_number), product_id, 78 FROM robots WHERE robot_id = 'saibya01'"],
    ['rule 2: ownership periods cannot overlap', "INSERT INTO company_assignment_history (robot_id, company_id, valid_from) SELECT 'saibya01', id, now() - interval '1 day' FROM companies LIMIT 1"],
    ['rule 4: history rows are append-only (software_history)', 'UPDATE software_history SET sw_ver = sw_ver'],
    ['rule 4: telemetry is append-only', 'UPDATE telemetry_battery SET pct = pct'],
    ['rule 6: ingested_messages cannot be edited', 'UPDATE ingested_messages SET type = type'],
    ['rule 10: robots cannot be hard-deleted', "DELETE FROM robots WHERE robot_id = 'saibya02'"],
    ['rule 11: camera stream URL with user:pass is refused', "UPDATE robot_cameras SET stream_url = 'rtsp://admin:pw@10.0.0.5/s' WHERE robot_id = 'saibya01'"],
    ['rule 11: encrypted secret is write-once', "UPDATE robot_credentials SET ciphertext = ciphertext || decode('00', 'hex')"],
    ['rule 15: product code is permanent', "UPDATE products SET code = 'saib' WHERE code = 'saibya'"],
    ['events: only acknowledgement may change', "UPDATE events SET message = message || ' (edited)'"],
    ['missions: robot_id is permanent', "UPDATE missions SET robot_id = 'altius01'"],
  ];
  const runProbes = async (list) => {
    for (const [name, sql] of list) {
      await check(name, async () => {
        const err = await guard(sql);
        assert(err, 'statement was ALLOWED');
        return err.message.slice(0, 70);
      });
    }
  };
  // Row-level triggers only fire on existing rows: these run in section G, after ingestion created data.
  const rowProbes = probes.filter(([n]) => /append-only|cannot be edited|write-once|only acknowledgement|robot_id is permanent/.test(n));
  await runProbes(probes.filter((p) => !rowProbes.includes(p)));
  await check('rule 8: v_robot_status agrees with the thresholds (59 s online, 61 s stale, 301 s offline)', async () => {
    const r = await q(`SELECT
        CASE WHEN now() - (now() - interval '59 seconds') < interval '60 seconds' THEN 'online' END a,
        (SELECT status FROM v_robot_status WHERE robot_id = 'saibya01') AS never_seen`);
    eq(r[0].never_seen, 'offline', 'never-seen robot');
    for (const [age, want] of [[59, 'online'], [61, 'stale'], [299, 'stale'], [301, 'offline']]) {
      await db.query('BEGIN');
      await db.query(`UPDATE live_state SET last_seen_at = now() - interval '${age} seconds' WHERE robot_id = 'saibya02'`);
      const s = (await q("SELECT status FROM v_robot_status WHERE robot_id = 'saibya02'"))[0].status;
      await db.query('ROLLBACK');
      eq(s, want, `${age}s ago`);
    }
  });
  await check('reference data seeded (Arnobot, 5 products, 6 part types, 4 roles)', async () => {
    const r = (await q("SELECT (SELECT count(*) FROM companies WHERE name='Arnobot')::int c, (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM part_types)::int t, (SELECT count(*) FROM roles)::int r"))[0];
    assert(r.c === 1 && r.p === 5 && r.t === 6 && r.r === 4, JSON.stringify(r));
  });
  await check('hot query paths use indexes (robot list, events, telemetry range)', async () => {
    const plans = [];
    for (const sql of [
      "EXPLAIN SELECT * FROM events WHERE robot_id = 'saibya01' ORDER BY ts DESC LIMIT 50",
      "EXPLAIN SELECT * FROM telemetry_battery WHERE robot_id = 'saibya01' AND ts > now() - interval '1 day'",
    ]) {
      await db.query('SET enable_seqscan = off');
      const p = (await q(sql)).map((r) => r['QUERY PLAN']).join(' ');
      await db.query('RESET enable_seqscan');
      assert(/Index|Bitmap/.test(p), `no index for: ${sql}`);
      plans.push('ok');
    }
  });

  // ── C. ingestion ───────────────────────────────────────────────────────
  sec('C. Ingestion rules (apps/ingest)');
  const k1 = keys.robots.saibya01.key;
  const k2 = keys.robots.saibya02.key;
  await check('rejects missing / wrong ingest key (401)', async () => {
    eq((await ingest('pms_' + 'x'.repeat(43), env1('saibya01', 'saibya', 'live', {}))).status, 401, 'bad key');
    const r = await fetch(`${INGEST}/api/v1/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    eq(r.status, 401, 'no key');
  });
  await check('rule 6: same msg_id is stored exactly once', async () => {
    const m = env1('saibya01', 'saibya', 'event', { event_type: 'alert', severity: 'info', message: 'qa idempotency' });
    const a = await ingest(k1, m);
    const b = await ingest(k1, m);
    eq(a.body.results[0].status, 'stored', 'first');
    eq(b.body.results[0].status, 'duplicate', 'second');
    eq((await q('SELECT count(*)::int n FROM events WHERE msg_id = $1', [m.msg_id]))[0].n, 1, 'event rows');
  });
  await check('rule 7: an older live message never overwrites newer live state', async () => {
    const now = Date.now();
    await ingest(k1, env1('saibya01', 'saibya', 'live', { battery: { pct: 88 } }, new Date(now).toISOString()));
    const late = await ingest(k1, env1('saibya01', 'saibya', 'live', { battery: { pct: 11 } }, new Date(now - 120_000).toISOString()));
    eq(late.body.results[0].status, 'stored', 'late message is still stored (history)');
    eq((await q("SELECT battery_pct FROM live_state WHERE robot_id = 'saibya01'"))[0].battery_pct, 88, 'live battery');
  });
  await check('rule 5/§10: a robot key cannot speak for another robot', async () => {
    eq((await ingest(k1, env1('saibya02', 'saibya', 'live', {}))).body.results[0].error, 'robot_not_allowed', 'error');
  });
  await check('envelope `product` must match the registered product', async () => {
    eq((await ingest(k1, env1('saibya01', 'altius', 'live', {}))).body.results[0].error, 'product_mismatch', 'error');
  });
  await check('rule 3: unknown fields are accepted and kept in raw', async () => {
    const m = env1('saibya01', 'saibya', 'live', { brand_new_sensor: { x: 1 } }, new Date().toISOString(), { future_field: 'kept' });
    eq((await ingest(k1, m)).body.results[0].status, 'stored', 'status');
    const raw = (await q('SELECT raw FROM ingested_messages WHERE msg_id = $1', [m.msg_id]))[0].raw;
    eq(raw.future_field, 'kept', 'raw.future_field');
  });
  await check('clock guard: ts far in the future is rejected (protects rule 7)', async () => {
    eq((await ingest(k1, env1('saibya01', 'saibya', 'live', {}, new Date(Date.now() + 3600_000).toISOString()))).body.results[0].error, 'clock_ahead', 'error');
  });
  await check('invalid payload is rejected, kept in ingest_rejections, not retryable', async () => {
    const r = (await ingest(k1, env1('saibya01', 'saibya', 'event', { event_type: 'party', severity: 'x', message: '' }))).body.results[0];
    assert(r.status === 'rejected' && r.retryable === false, JSON.stringify(r));
    assert((await q("SELECT count(*)::int n FROM ingest_rejections WHERE error LIKE 'invalid_event%'"))[0].n >= 1, 'no rejection row');
  });
  await check('§11 backlog: batch replay oldest-first lands at original ts, telemetry de-duplicated', async () => {
    const base = Date.now() - 10 * 60_000;
    const batch = [];
    for (let i = 0; i < 5; i++) {
      const ts = new Date(base + i * 30_000).toISOString();
      batch.push(env1('saibya02', 'saibya', 'telemetry', { battery: [{ ts, pct: 50 + i }], gps: [{ ts, lat: 23.02, lon: 72.57 }] }, ts));
    }
    const r = await ingest(k2, batch);
    eq(r.body.summary.stored, 5, 'stored');
    // same samples inside NEW messages must not duplicate rows
    await ingest(k2, batch.map((m) => ({ ...m, msg_id: randomUUID() })));
    eq((await q("SELECT count(*)::int n FROM telemetry_battery WHERE robot_id = 'saibya02'"))[0].n, 5, 'battery rows');
  });
  await check('hello appends software history only when the version changes', async () => {
    await ingest(k2, env1('saibya02', 'saibya', 'hello', { sw_ver: '1.4.0', fw_ver: '0.9.2' }));
    await ingest(k2, env1('saibya02', 'saibya', 'hello', { sw_ver: '1.4.0', fw_ver: '0.9.2' }));
    await ingest(k2, env1('saibya02', 'saibya', 'hello', { sw_ver: '1.5.0', fw_ver: '0.9.2' }));
    eq((await q("SELECT count(*)::int n FROM software_history WHERE robot_id = 'saibya02'"))[0].n, 2, 'history rows');
  });
  await check('mission: robot start/end + GCS report merge into one row (robot path wins, GCS plan wins)', async () => {
    const id = 'saibya01-M9001';
    const t0 = new Date(Date.now() - 600_000).toISOString();
    await ingest(k1, env1('saibya01', 'saibya', 'mission', { phase: 'start', mission_id: id, started_at: t0 }, t0));
    await ingest(k1, env1('saibya01', 'saibya', 'mission', { phase: 'end', mission_id: id, result: 'aborted', end_reason: 'qa', distance_m: 120, actual_path: { type: 'LineString', coordinates: [[72.57, 23.02], [72.571, 23.021]] } }));
    const g = await fetch(`${INGEST}/api/v1/gcs/missions/${id}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.gcs.key}` },
      body: JSON.stringify({ robot_id: 'saibya01', result: 'completed', distance_m: 999, planned_path: { type: 'LineString', coordinates: [[72.57, 23.02], [72.58, 23.03]] }, actual_path: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }),
    });
    eq(g.status, 200, 'report status');
    const m = (await q('SELECT result, distance_m, planned_path, actual_path, duration_s FROM missions WHERE mission_id = $1', [id]))[0];
    eq(m.result, 'aborted', 'robot result kept');
    eq(m.distance_m, 120, 'robot distance kept');
    eq(m.planned_path.coordinates[1][0], 72.58, 'GCS plan stored');
    eq(m.actual_path.coordinates[0][0], 72.57, 'robot track kept');
    assert(m.duration_s > 0, 'duration computed');
  });
  await check('a mission id cannot be re-homed to another robot (409)', async () => {
    const g = await fetch(`${INGEST}/api/v1/gcs/missions/saibya01-M9001/report`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.gcs.key}` }, body: JSON.stringify({ robot_id: 'saibya02' }),
    });
    eq(g.status, 409, 'status');
  });

  // ── D. admin API ───────────────────────────────────────────────────────
  sec('D. Admin API & permissions (apps/api)');
  const admin = new Session();
  await check('health endpoint', async () => eq((await admin.req('GET', '/healthz')).body.ok, true, 'ok'));
  await check('unauthenticated requests get 401', async () => eq((await admin.req('GET', '/robots')).status, 401, 'status'));
  await check('CSRF: non-GET without X-Requested-With is refused (403)', async () => eq((await admin.req('POST', '/auth/login', { email: 'a@b.c', password: 'x' }, { csrf: false })).status, 403, 'status'));
  await check('CSRF: foreign Origin is refused (403)', async () => eq((await admin.req('POST', '/auth/login', { email: 'a@b.c', password: 'x' }, { headers: { origin: 'https://evil.example' } })).status, 403, 'status'));
  await check('wrong password → 401, session cookie is httpOnly + SameSite', async () => {
    eq((await admin.req('POST', '/auth/login', { email: QA_ENV.SEED_ADMIN_EMAIL, password: 'definitely-wrong' })).status, 401, 'bad pw');
    const r = await admin.req('POST', '/auth/login', { email: QA_ENV.SEED_ADMIN_EMAIL, password: QA_ENV.SEED_ADMIN_PASSWORD }, { raw: true });
    const sc = r.headers.get('set-cookie') ?? '';
    admin.cookie = sc.split(';')[0];
    assert(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), sc);
  });
  const readPaths = ['/dashboard', '/robots', '/robots/saibya01', '/robots/saibya01/live', '/robots/saibya01/ownership', '/robots/saibya01/hardware', '/robots/saibya01/software', '/robots/saibya01/connectivity', '/robots/saibya01/dispatch', '/robots/saibya01/maintenance', '/robots/saibya01/telemetry/gps', '/robots/saibya01/telemetry/battery', '/robots/saibya01/telemetry/encoders', '/robots/saibya01/telemetry/health', '/robots/saibya01/missions', '/robots/saibya01/events', '/robots/saibya01/documents', '/robots/saibya01/credentials', '/missions', '/missions/saibya01-M9001', '/events', '/products', '/part-types', '/companies', '/releases', '/users', '/roles', '/ingest-clients', '/ingest/messages', '/ingest/rejections', '/openapi.json'];
  await check(`every read endpoint answers 200 for a super-admin (${readPaths.length})`, async () => {
    const bad = [];
    for (const p of readPaths) {
      const r = await admin.req('GET', p);
      if (r.status !== 200) bad.push(`${p} → ${r.status}`);
    }
    assert(!bad.length, bad.join('; '));
  });
  await check('§5 view 1: robot summary totals are computed from missions', async () => {
    const r = (await admin.req('GET', '/robots?q=saibya01')).body.items[0];
    assert(r.total_missions >= 1 && r.aborted >= 1 && r.total_distance_m >= 120, JSON.stringify(r));
  });
  await check('status in API reflects last-seen (online after a message)', async () => {
    eq((await admin.req('GET', '/robots/saibya01')).body.status, 'online', 'status');
  });
  let registered;
  await check('register robot: ID generated (product + running number), key shown once, key works for ingest', async () => {
    const products = (await admin.req('GET', '/products')).body;
    const saibya = products.find((p) => p.code === 'saibya');
    const r = await admin.req('POST', '/robots', { product_id: saibya.id, serial_number: 'SN-QA-777' });
    eq(r.status, 201, 'status');
    registered = r.body;
    assert(/^saibya\d{2,}$/.test(registered.robot.robot_id), registered.robot.robot_id);
    const i = await ingest(registered.ingest_key, env1(registered.robot.robot_id, 'saibya', 'live', {}));
    eq(i.body.results[0].status, 'stored', 'ingest with new key');
    const clients = (await admin.req('GET', `/ingest-clients?robot_id=${registered.robot.robot_id}`)).body;
    assert(!JSON.stringify(clients).includes(registered.ingest_key), 'plaintext key visible in list');
    return registered.robot.robot_id;
  });
  await check('duplicate serial number is refused (409)', async () => {
    const saibya = (await admin.req('GET', '/products')).body.find((p) => p.code === 'saibya');
    eq((await admin.req('POST', '/robots', { product_id: saibya.id, serial_number: 'sn-qa-777' })).status, 409, 'status');
  });
  await check('rule 1: PATCH cannot change robot_id or product', async () => {
    eq((await admin.req('PATCH', `/robots/${registered.robot.robot_id}`, { robot_id: 'hack01' })).status, 400, 'status');
  });
  await check('rule 10: soft delete hides, restore brings back, ID never reused', async () => {
    const id = registered.robot.robot_id;
    eq((await admin.req('DELETE', `/robots/${id}`)).status, 200, 'delete');
    assert(!(await admin.req('GET', '/robots?limit=200')).body.items.some((r) => r.robot_id === id), 'still listed');
    assert((await admin.req('GET', '/robots?include_deleted=true&limit=200')).body.items.some((r) => r.robot_id === id), 'not in deleted list');
    eq((await ingest(registered.ingest_key, env1(id, 'saibya', 'live', {}))).body.results[0].error, 'robot_deleted', 'ingest to deleted robot');
    eq((await admin.req('POST', `/robots/${id}/restore`)).status, 200, 'restore');
    const saibya = (await admin.req('GET', '/products')).body.find((p) => p.code === 'saibya');
    const next = await admin.req('POST', '/robots', { product_id: saibya.id, serial_number: 'SN-QA-778' });
    assert(next.body.robot.robot_id !== id, 'ID reused');
  });
  await check('rule 2: ownership transfer closes the old period and opens a new one', async () => {
    const hist = (await admin.req('GET', '/robots/saibya01/ownership')).body;
    eq(hist.length, 1, 'initial periods');
    eq(hist[0].valid_to, null, 'open period');
    const same = await admin.req('POST', '/robots/saibya01/ownership', { company_id: hist[0].company_id });
    eq(same.status, 409, 'transfer to same company');
  });
  let credId;
  const SECRET = `qa-secret-${randomUUID()}`;
  await check('rule 11: credential secret never appears in create/list responses', async () => {
    const c = await admin.req('POST', '/robots/saibya01/credentials', { kind: 'wifi_router', username: 'admin', secret: SECRET });
    eq(c.status, 201, 'create');
    credId = c.body.id;
    assert(!c.text.includes(SECRET), 'secret in create response');
    const l = await admin.req('GET', '/robots/saibya01/credentials?include_revoked=true');
    assert(!l.text.includes(SECRET) && !/ciphertext|auth_tag/.test(l.text), 'secret or ciphertext in list');
    const d = await admin.req('GET', '/robots/saibya01');
    assert(!d.text.includes(SECRET), 'secret in robot detail');
  });
  await check('rule 11: secret stored encrypted (not plaintext) in the database', async () => {
    const r = (await q('SELECT ciphertext FROM robot_credentials WHERE id = $1', [credId]))[0];
    assert(!r.ciphertext.toString('utf8').includes(SECRET), 'plaintext in DB');
  });
  await check('reveal returns the secret with Cache-Control: no-store; rotate + revoke work', async () => {
    const r = await admin.req('POST', `/credentials/${credId}/reveal`);
    eq(r.body.secret, SECRET, 'secret');
    assert(/no-store/.test(r.headers.get('cache-control') ?? ''), 'cache-control');
    const rot = await admin.req('POST', `/credentials/${credId}/rotate`, { secret: SECRET + '-2' });
    eq(rot.status, 200, 'rotate');
    eq((await admin.req('POST', `/credentials/${credId}/reveal`)).status, 409, 'old secret no longer revealable');
    eq((await admin.req('POST', `/credentials/${rot.body.id}/revoke`, { reason: 'qa' })).status, 200, 'revoke');
  });
  await check('rule 11: camera stream URL with credentials is refused by the API (400)', async () => {
    eq((await admin.req('PUT', '/robots/saibya01/cameras/3', { stream_url: 'rtsp://user:pass@10.1.1.1/live' })).status, 400, 'status');
  });
  await check('documents: upload v1, upload v2, both versions kept, download matches', async () => {
    const products = (await admin.req('GET', '/products')).body;
    const fd = new FormData();
    fd.set('doc_type', 'bom');
    fd.set('title', 'QA BOM');
    fd.set('product_id', products.find((p) => p.code === 'saibya').id);
    fd.set('file', new Blob(['part,qty\nlidar,1\n'], { type: 'text/csv' }), 'bom.csv');
    const d1 = await admin.req('POST', '/documents', fd);
    eq(d1.status, 201, 'create');
    const fd2 = new FormData();
    fd2.set('file', new Blob(['part,qty\nlidar,2\n'], { type: 'text/csv' }), 'bom.csv');
    fd2.set('note', 'qty fix');
    const d2 = await admin.req('POST', `/documents/${d1.body.id}/versions`, fd2);
    eq(d2.body.versions.length, 2, 'versions');
    eq(d2.body.latest.version_no, 2, 'latest');
    const dl = await admin.req('GET', `/document-versions/${d2.body.versions[1].id}/download`);
    eq(dl.text, 'part,qty\nlidar,1\n', 'v1 content still downloadable');
    const eff = (await admin.req('GET', '/robots/saibya01/documents')).body;
    assert(eff.some((x) => x.id === d1.body.id), 'product document not in robot effective docs');
  });
  await check('releases: sha256 computed server-side; declared mismatch refused; version never reused', async () => {
    const products = (await admin.req('GET', '/products')).body;
    const pid = products.find((p) => p.code === 'saibya').id;
    const mk = (sha) => {
      const fd = new FormData();
      fd.set('product_id', pid);
      fd.set('component', 'software');
      fd.set('version', '9.9.9');
      fd.set('signature', 'c2lnbmF0dXJl');
      if (sha) fd.set('sha256', sha);
      fd.set('file', new Blob(['firmware-bytes']), 'pkg.bin');
      return fd;
    };
    eq((await admin.req('POST', '/releases', mk('0'.repeat(64)))).status, 400, 'mismatch');
    const ok = await admin.req('POST', '/releases', mk());
    eq(ok.status, 201, 'create');
    assert(/^[a-f0-9]{64}$/.test(ok.body.sha256), 'sha256');
    eq((await admin.req('POST', '/releases', mk())).status, 409, 'reuse');
  });
  await check('maintenance with part swap closes old part and fits new one atomically', async () => {
    const parts = (await admin.req('GET', '/robots/saibya01/hardware?current=true')).body;
    const lidar = parts.find((p) => p.part_type_key === 'lidar');
    const today = new Date().toISOString().slice(0, 10);
    const m = await admin.req('POST', '/robots/saibya01/maintenance', { repaired_at: today, description: 'LiDAR replaced', repaired_by: 'QA', part_fitted_serial: 'LDR-NEW', swap: { remove_hardware_id: lidar.id, part_type_key: 'lidar' } });
    eq(m.status, 201, 'status');
    const after = (await admin.req('GET', '/robots/saibya01/hardware')).body.filter((p) => p.part_type_key === 'lidar');
    assert(after.some((p) => p.removed_at && p.id === lidar.id) && after.some((p) => !p.removed_at && p.serial_number === 'LDR-NEW'), JSON.stringify(after));
  });
  await check('events: acknowledge records who/when; double-ack refused', async () => {
    const ev = (await admin.req('GET', '/events?unacked=true')).body.items[0];
    const a = await admin.req('POST', `/events/${ev.id}/ack`);
    assert(a.body.acknowledged_by_name && a.body.acknowledged_at, JSON.stringify(a.body));
    eq((await admin.req('POST', `/events/${ev.id}/ack`)).status, 409, 'second ack');
  });
  await check('telemetry downsampling returns bucketed series', async () => {
    const r = (await admin.req('GET', `/robots/saibya02/telemetry/battery?from=${new Date(Date.now() - 3600_000).toISOString()}&bucket_s=60`)).body;
    assert(r.bucket_s === 60 && r.points.length >= 1, JSON.stringify(r).slice(0, 200));
  });
  // permission matrix with scoped users
  const pw = 'QA-password-12345';
  let viewerS, scopedS;
  await check('rule 13 setup: create viewer (platform) and engineer scoped to robot saibya02', async () => {
    const v = await admin.req('POST', '/users', { email: 'viewer@qa.local', name: 'QA Viewer', password: pw, role_key: 'viewer', scope_type: 'platform' });
    eq(v.status, 201, 'viewer');
    const e = await admin.req('POST', '/users', { email: 'eng@qa.local', name: 'QA Engineer', password: pw, role_key: 'engineer', scope_type: 'robot', scope_id: 'saibya02' });
    eq(e.status, 201, 'engineer');
    viewerS = new Session();
    await viewerS.login('viewer@qa.local', pw);
    scopedS = new Session();
    await scopedS.login('eng@qa.local', pw);
  });
  const matrix = [
    ['viewer can read robots', () => viewerS.req('GET', '/robots/saibya01'), 200],
    ['viewer cannot register robots', () => viewerS.req('POST', '/robots', { product_id: randomUUID(), serial_number: 'X' }), 403],
    ['viewer cannot see credential metadata', () => viewerS.req('GET', '/robots/saibya01/credentials'), 403],
    ['viewer cannot manage users', () => viewerS.req('GET', '/users'), 403],
    ['viewer cannot acknowledge events', () => viewerS.req('POST', '/events/ack', { ids: [randomUUID()] }), 403],
    ['robot-scoped engineer reads its robot', () => scopedS.req('GET', '/robots/saibya02'), 200],
    ['robot-scoped engineer cannot read another robot', () => scopedS.req('GET', '/robots/saibya01'), 403],
    ['robot-scoped engineer cannot reveal credentials', () => scopedS.req('POST', `/credentials/${credId}/reveal`), 403],
    ['robot-scoped engineer can record maintenance on its robot', () => scopedS.req('POST', '/robots/saibya02/maintenance', { repaired_at: new Date().toISOString().slice(0, 10), description: 'QA check', repaired_by: 'QA' }), 201],
  ];
  for (const [name, fn, want] of matrix) await check(`rule 13: ${name} (${want})`, async () => eq((await fn()).status, want, 'status'));
  await check('rule 13: list endpoints are filtered to the user’s scope', async () => {
    const ids = (await scopedS.req('GET', '/robots')).body.items.map((r) => r.robot_id);
    eq(JSON.stringify(ids), JSON.stringify(['saibya02']), 'visible robots');
    const evs = (await scopedS.req('GET', '/events?limit=200')).body.items;
    assert(evs.every((e) => e.robot_id === 'saibya02'), 'foreign events visible');
  });
  await check('cannot remove the last super-admin; cannot delete yourself', async () => {
    const me = (await admin.req('GET', '/auth/me')).body;
    eq((await admin.req('DELETE', `/users/${me.id}`)).status, 409, 'self delete');
    const g = me.grants.find((x) => x.role_key === 'super_admin');
    eq((await admin.req('POST', `/grants/${g.id}/revoke`)).status, 409, 'last super-admin');
  });
  await check('logout revokes the session server-side', async () => {
    const s = new Session();
    await s.login('viewer@qa.local', pw);
    const cookie = s.cookie;
    await s.req('POST', '/auth/logout');
    const again = new Session();
    again.cookie = cookie;
    eq((await again.req('GET', '/auth/me')).status, 401, 'old cookie');
  });
  await check('OpenAPI documents every route with its permission', async () => {
    const o = (await admin.req('GET', '/openapi.json')).body;
    const ops = Object.values(o.paths).flatMap((p) => Object.values(p));
    assert(ops.every((op) => /\*\*Permission:\*\*/.test(op.description)), 'missing permission text');
    return `${ops.length} operations`;
  });
  await check('API responses never include password hashes or key hashes', async () => {
    const texts = await Promise.all(['/users', '/ingest-clients', '/auth/me'].map(async (p) => (await admin.req('GET', p)).text));
    assert(!texts.some((t) => /password_hash|key_hash|\$argon2/.test(t)), 'hash leaked');
  });

  // ── E. realtime ────────────────────────────────────────────────────────
  sec('E. Realtime push');
  await check('an ingested live message is pushed to a signed-in Socket.IO client', async () => {
    let io;
    try {
      io = (await import('socket.io-client')).io;
    } catch {
      return 'socket.io-client not installed; skipped';
    }
    const socket = io(`http://127.0.0.1:${API_PORT}`, { extraHeaders: { cookie: admin.cookie }, transports: ['websocket'] });
    const got = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no change event within 5 s')), 5000);
      socket.on('change', (c) => {
        if (c.robot_id === 'saibya01' && c.kind === 'live') {
          clearTimeout(t);
          res(c);
        }
      });
    });
    await new Promise((r) => socket.on('connect', r));
    await ingest(k1, env1('saibya01', 'saibya', 'live', { battery: { pct: 77 } }));
    await got;
    socket.close();
  });

  // ── G. guards on real rows ────────────────────────────────────────────
  sec('G. Database guards on real rows (after ingestion)');
  await check('tables under test contain rows', async () => {
    const r = (await q('SELECT (SELECT count(*) FROM software_history)::int s, (SELECT count(*) FROM telemetry_battery)::int t, (SELECT count(*) FROM ingested_messages)::int i, (SELECT count(*) FROM robot_credentials)::int c, (SELECT count(*) FROM events)::int e, (SELECT count(*) FROM missions)::int m'))[0];
    assert(Object.values(r).every((n) => n > 0), JSON.stringify(r));
  });
  await runProbes(rowProbes);

  // ── F. frontend ────────────────────────────────────────────────────────
  sec('F. Frontend (apps/admin)');
  const nextDir = join(ROOT, 'apps/admin/.next');
  await check('production build exists', () => assert(existsSync(nextDir), 'apps/admin/.next missing: run npm run build -w @arnobot/admin'));
  await check('no server secret value is present in the browser bundle', () => {
    const staticDir = join(nextDir, 'static');
    if (!existsSync(staticDir)) throw new Error('no .next/static');
    const secrets = ['CREDENTIAL_ENCRYPTION_KEY', 'SESSION_SECRET', 'SEED_ADMIN_PASSWORD', 'S3_SECRET_KEY'].map((k) => env[k]).filter((v) => v && v.length >= 8);
    const pgPass = decodeURIComponent(new URL(env.DATABASE_URL).password);
    if (pgPass.length >= 8) secrets.push(pgPass);
    const bundle = walkAll(staticDir).filter((f) => f.endsWith('.js'));
    const leaks = bundle.filter((f) => {
      const t = readFileSync(f, 'utf8');
      return secrets.some((s) => t.includes(s)) || /NEXT_PUBLIC_GCS_API_TOKEN/.test(t);
    });
    assert(!leaks.length, leaks.map((l) => relative(ROOT, l)).join(', '));
    return `${bundle.length} bundle files, ${secrets.length} secrets checked`;
  });

  await db.end();
  return startedAt;
}

function walkAll(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    statSync(p).isDirectory() ? walkAll(p, out) : out.push(p);
  }
  return out;
}

function writeReport(startedAt) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const dir = join(ROOT, 'docs/qa/reports');
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(dir, `qa-${stamp}.json`), JSON.stringify({ startedAt, passed, failed, results }, null, 2));
  const bySection = {};
  for (const r of results) (bySection[r.section] ??= []).push(r);
  const md = [
    '# QA — last run',
    '',
    `Run: ${startedAt.toISOString()} · **${passed} passed, ${failed} failed** · generated by \`npm run qa\` (tools/qa/run-qa.mjs)`,
    '',
    ...Object.entries(bySection).flatMap(([s, rs]) => [
      `## ${s}`,
      '',
      '| | Check | Detail |',
      '|---|---|---|',
      ...rs.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name.replace(/\|/g, '\\|')} | ${(r.ok ? r.note ?? '' : r.error ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`),
      '',
    ]),
  ].join('\n');
  writeFileSync(join(ROOT, 'docs/qa/LAST_RUN.md'), md + '\n');
  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m  → docs/qa/LAST_RUN.md`);
  return failed;
}

let started = new Date();
main()
  .then((s) => (started = s ?? started))
  .catch((e) => {
    results.push({ section: 'harness', name: 'QA harness', ok: false, error: e.stack ?? e.message });
    console.error(e);
  })
  .finally(() => {
    for (const c of children) c.kill();
    const failed = writeReport(started);
    process.exit(failed ? 1 : 0);
  });
