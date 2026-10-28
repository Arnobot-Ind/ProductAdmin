import { describe, expect, it } from 'vitest';
import { parseDvrKey, parseSessionKey, robotForFolder } from './keys';

describe('parseDvrKey (DVR footage copied into the bucket)', () => {
  const IST = 330;

  it('reads camera, day and local start time', () => {
    const d = parseDvrKey('adani-trails/Part 1 - 2026-10-04 to 10-06 2122/Video/cam2/2026-10-04/22-33-26.ts', IST);
    expect(d).toEqual({ camera: 'cam2', day: '20261004', name: 'video/cam2/20261004_223326.ts', chunkStart: Date.parse('2026-10-04T22:33:26+05:30') });
  });

  it('skips sub streams, stills and other layouts', () => {
    expect(parseDvrKey('x/Video/cam1_sub/2026-10-04/22-33-26.ts', IST)).toBeNull();
    expect(parseDvrKey('x/Video/_rep0910/cam1_181956.jpg', IST)).toBeNull();
    expect(parseDvrKey('saibya02/sessions/20260926_000825_dvr/video/cam1/20260926_000825.ts', IST)).toBeNull();
  });
});

describe('parseDvrKey clock check', () => {
  it('skips footage recorded before the clock was set', () => {
    expect(parseDvrKey('x/Video/cam1/1970-01-01/05-30-12.ts', 330)).toBeNull();
  });
});

describe('robotForFolder (ARCHIVE_ROBOT_ALIASES)', () => {
  const aliases = new Map([['ductrobot01', 'ductcleaning01']]);
  it('maps an aliased folder to its registered robot', () => {
    const key = parseSessionKey('ductrobot01/sessions/20260926_112634_session02/video/cam1/20260926_112634.ts');
    expect(key?.robotId).toBe('ductrobot01');
    expect(robotForFolder(key!.robotId, aliases)).toBe('ductcleaning01');
  });
  it('leaves other folders alone', () => {
    expect(robotForFolder('saibya02', aliases)).toBe('saibya02');
    expect(robotForFolder('ductcleaning01', aliases)).toBe('ductcleaning01');
  });
});

