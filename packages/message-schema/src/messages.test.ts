import { describe, expect, it } from 'vitest';
import { computeRobotStatus, gcsMissionReportSchema, parseRobotMessage } from './index';

const base = {
  v: 1,
  msg_id: '6f1c2a9e-4b7d-4e0a-9c1f-2d8e5a7b3c10',
  robot_id: 'saibya01',
  product: 'saibya',
  sw_ver: '1.4.0',
  fw_ver: '0.9.2',
  ts: '2026-09-26T10:30:00.000Z',
};

describe('envelope', () => {
  it('accepts the spec §6 example', () => {
    const r = parseRobotMessage({ ...base, type: 'live', payload: {} });
    expect(r.ok).toBe(true);
  });

  it('keeps unknown fields instead of rejecting (rule 3)', () => {
    const r = parseRobotMessage({ ...base, type: 'live', future_field: 42, payload: { new_sensor: { x: 1 } } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.message as unknown as Record<string, unknown>).future_field).toBe(42);
      expect((r.message.payload as Record<string, unknown>).new_sensor).toEqual({ x: 1 });
    }
  });

  it.each([
    ['missing msg_id', { ...base, msg_id: undefined }],
    ['bad robot_id', { ...base, robot_id: 'Saibya 1' }],
    ['unknown type', { ...base, type: 'gossip' }],
    ['unsupported version', { ...base, v: 99 }],
    ['ts without zone', { ...base, ts: '2026-09-26T10:30:00' }],
  ])('rejects %s', (_label, msg) => {
    const r = parseRobotMessage({ type: 'live', payload: {}, ...msg });
    expect(r.ok).toBe(false);
  });

  it('never throws on garbage', () => {
    for (const g of [null, 1, 'x', [], { v: 1 }]) expect(parseRobotMessage(g).ok).toBe(false);
  });
});

describe('payloads', () => {
  it('normalises health case', () => {
    const r = parseRobotMessage({ ...base, type: 'live', payload: { health: { lidar: 'FAULT' } } });
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'live') expect(r.message.payload.health?.lidar).toBe('fault');
  });

  it('rejects out-of-range latitude', () => {
    const r = parseRobotMessage({ ...base, type: 'live', payload: { position: { lat: 123, lon: 0 } } });
    expect(r.ok).toBe(false);
  });

  it('validates event type and severity', () => {
    expect(parseRobotMessage({ ...base, type: 'event', payload: { event_type: 'fault', severity: 'critical', message: 'x' } }).ok).toBe(true);
    expect(parseRobotMessage({ ...base, type: 'event', payload: { event_type: 'party', severity: 'critical', message: 'x' } }).ok).toBe(false);
  });

  it('mission end requires a result', () => {
    const start = { ...base, type: 'mission', payload: { phase: 'start', mission_id: 'saibya01-M0001' } };
    expect(parseRobotMessage(start).ok).toBe(true);
    const endNoResult = { ...base, type: 'mission', payload: { phase: 'end', mission_id: 'saibya01-M0001' } };
    expect(parseRobotMessage(endNoResult).ok).toBe(false);
  });

  it('telemetry samples need their own ts', () => {
    const ok = { ...base, type: 'telemetry', payload: { battery: [{ ts: base.ts, pct: 50 }] } };
    const bad = { ...base, type: 'telemetry', payload: { battery: [{ pct: 50 }] } };
    expect(parseRobotMessage(ok).ok).toBe(true);
    expect(parseRobotMessage(bad).ok).toBe(false);
  });

  it('gcs report accepts a planned path', () => {
    const r = gcsMissionReportSchema.safeParse({
      robot_id: 'saibya02',
      planned_path: { type: 'LineString', coordinates: [[72.5, 23.0], [72.6, 23.1]] },
      result: 'Completed',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.result).toBe('completed');
  });
});

describe('computeRobotStatus (spec §7)', () => {
  const now = new Date('2026-09-26T10:30:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it.each([
    [0, 'online'],
    [59_999, 'online'],
    [60_000, 'stale'],
    [300_000, 'stale'],
    [300_001, 'offline'],
  ])('%i ms ago → %s', (ms, expected) => {
    expect(computeRobotStatus(ago(ms), now)).toBe(expected);
  });
  it('never seen → offline', () => expect(computeRobotStatus(null, now)).toBe('offline'));
});
