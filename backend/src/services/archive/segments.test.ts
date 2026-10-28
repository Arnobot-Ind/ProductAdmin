import { describe, expect, it } from 'vitest';
import { cameraSegments } from './archive.service';

const chunk = (iso: string) => ({ object_key: `k/${iso}`, name: `video/cam1/${iso}.ts`, size_bytes: 1, chunk_start: new Date(iso) });

describe('cameraSegments (chunk lengths for the playlist)', () => {
  it('ends a short recording with the session, not after a nominal segment', () => {
    const segs = cameraSegments([chunk('2026-10-28T10:02:22Z')], 60, '2026-10-28T10:02:40Z');
    expect(segs.map((s) => s.duration)).toEqual([18]);
  });

  it('measures earlier chunks by the next one and the last by the session end', () => {
    const segs = cameraSegments([chunk('2026-10-28T10:00:00Z'), chunk('2026-10-28T10:01:00Z')], 60, '2026-10-28T10:01:25Z');
    expect(segs.map((s) => s.duration)).toEqual([60, 25]);
  });

  it('keeps the nominal length when the end is unknown or far after the last chunk', () => {
    expect(cameraSegments([chunk('2026-10-28T10:00:00Z')], 60).map((s) => s.duration)).toEqual([60]);
    expect(cameraSegments([chunk('2026-10-28T10:00:00Z')], 60, '2026-10-28T11:00:00Z').map((s) => s.duration)).toEqual([60]);
  });
});
