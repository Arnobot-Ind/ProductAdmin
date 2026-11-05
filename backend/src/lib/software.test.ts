import { describe, expect, it } from 'vitest';
import { commitFromVersion, deployedSoftware, type SoftwareReport } from './software';

const report = (at: string, source: 'robot' | 'manual', sw_ver: string | null, commit_id: string | null = null): SoftwareReport => ({ sw_ver, fw_ver: null, commit_id, at, source });

describe('commitFromVersion', () => {
  it('reads the commit from versions that carry one', () => {
    expect(commitFromVersion('git-0076906')).toBe('0076906');
    expect(commitFromVersion('v1.2.0-3-gABC1234')).toBe('abc1234');
  });
  it('does not guess from plain versions', () => {
    expect(commitFromVersion('1.5.0')).toBeNull();
    expect(commitFromVersion('2026110')).toBeNull();
    expect(commitFromVersion(null)).toBeNull();
  });
});

describe('deployedSoftware', () => {
  it('a boot report with no version does not hide the last known one', () => {
    const d = deployedSoftware([report('2026-11-03T00:00:00Z', 'robot', null), report('2026-10-08T00:00:00Z', 'robot', 'git-0076906')]);
    expect(d).toMatchObject({ deployed_version: 'git-0076906', deployed_at: '2026-10-08T00:00:00Z', deployed_source: 'robot', installed_commit_id: '0076906', installed_commit_source: 'robot' });
  });
  it('a version saved in the panel wins over an older robot report', () => {
    const d = deployedSoftware([report('2026-10-08T00:00:00Z', 'robot', 'git-0076906'), report('2026-11-05T00:00:00Z', 'manual', 'git-abcdef1', 'abcdef1234')]);
    expect(d).toMatchObject({ deployed_version: 'git-abcdef1', deployed_source: 'manual', installed_commit_id: 'abcdef1234', installed_commit_source: 'manual' });
  });
  it('a newer robot report wins over what was saved in the panel', () => {
    const d = deployedSoftware([report('2026-11-05T00:00:00Z', 'manual', 'git-abcdef1', 'abcdef1234'), report('2026-11-06T00:00:00Z', 'robot', 'git-1111111')]);
    expect(d).toMatchObject({ deployed_version: 'git-1111111', deployed_source: 'robot', installed_commit_id: '1111111' });
  });
  it('knows nothing when nothing was ever reported', () => {
    expect(deployedSoftware([report('2026-11-03T00:00:00Z', 'robot', null)])).toMatchObject({ deployed_version: null, installed_commit_id: null, deployed_source: null });
  });
});
