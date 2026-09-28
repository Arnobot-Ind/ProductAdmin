import type { Db } from '@arnobot/db';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IngestClient } from './auth';
import { IngestPipeline } from './pipeline';

/** Stub DB: records rejection inserts; any transaction attempt means the message got past validation. */
function stubDb() {
  const rejections: unknown[][] = [];
  let connects = 0;
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('ingest_rejections')) rejections.push(params);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      connects++;
      throw new Error('db down');
    },
  } as unknown as Db;
  return { db, rejections, connects: () => connects };
}
const log = { warn: () => undefined, error: () => undefined };
const client: IngestClient = { id: 'c1', name: 'saibya01 (robot)', kind: 'robot', keyId: 'k1', robotIds: new Set(['saibya01']) };
const msg = (over: Record<string, unknown> = {}) => ({
  v: 1,
  msg_id: randomUUID(),
  robot_id: 'saibya01',
  product: 'saibya',
  ts: new Date().toISOString(),
  type: 'live',
  payload: {},
  ...over,
});

describe('IngestPipeline decisions (before touching the DB)', () => {
  it('rejects an invalid envelope as non-retryable and records it', async () => {
    const s = stubDb();
    const r = await new IngestPipeline(s.db, log).process({ v: 1, robot_id: 'saibya01' }, client, 'https');
    expect(r).toMatchObject({ status: 'rejected', error: 'invalid_envelope', retryable: false });
    expect(s.rejections).toHaveLength(1);
    expect(s.connects()).toBe(0);
  });

  it('refuses a robot the key may not speak for (rule 5 / §10)', async () => {
    const s = stubDb();
    const r = await new IngestPipeline(s.db, log).process(msg({ robot_id: 'saibya02' }), client, 'https');
    expect(r.error).toBe('robot_not_allowed');
    expect(s.connects()).toBe(0);
  });

  it('refuses clocks far in the future or before sync (protects rule 7)', async () => {
    const s = stubDb();
    const p = new IngestPipeline(s.db, log);
    expect((await p.process(msg({ ts: new Date(Date.now() + 3_600_000).toISOString() }), client, 'https')).error).toBe('clock_ahead');
    expect((await p.process(msg({ ts: '1970-01-01T00:00:10.000Z' }), client, 'https')).error).toBe('clock_unsynced');
  });

  it('checks every telemetry sample timestamp, not only the envelope', async () => {
    const s = stubDb();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const r = await new IngestPipeline(s.db, log).process(msg({ type: 'telemetry', payload: { battery: [{ ts: future, pct: 50 }] } }), client, 'https');
    expect(r.error).toBe('clock_ahead');
  });

  it('a transient DB failure is reported as retryable so the robot keeps the message', async () => {
    const s = stubDb();
    const r = await new IngestPipeline(s.db, log).process(msg(), client, 'https');
    expect(r).toMatchObject({ status: 'rejected', error: 'internal_error', retryable: true });
    expect(s.connects()).toBe(1);
  });

  it('processes a batch strictly in order', async () => {
    const s = stubDb();
    const a = msg({ robot_id: 'saibya02' });
    const b = msg({ v: 99 });
    const r = await new IngestPipeline(s.db, log).processBatch([a, b], client, 'https');
    expect(r.map((x) => x.msg_id)).toEqual([a.msg_id, b.msg_id]);
  });
});
