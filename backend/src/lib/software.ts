/** The commit inside a version a robot reports: "git-0076906", or git describe's "v1.2.0-3-g0076906". */
export function commitFromVersion(version: string | null): string | null {
  const m = /^git-([0-9a-f]{7,64})$/i.exec(version ?? '') ?? /-g([0-9a-f]{7,64})$/i.exec(version ?? '');
  return m ? m[1].toLowerCase() : null;
}

export interface SoftwareReport {
  sw_ver: string | null;
  fw_ver: string | null;
  commit_id: string | null;
  at: string;
  source: 'robot' | 'manual';
}

/** What is deployed, as far as anyone knows: for each field the newest report that has it, from the robot or the panel. */
export function deployedSoftware(reports: SoftwareReport[]) {
  const newest = [...reports].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const version = newest.find((r) => r.sw_ver);
  const commit = newest.map((r) => ({ r, id: r.commit_id ?? commitFromVersion(r.sw_ver) })).find((c) => c.id);
  return {
    deployed_version: version?.sw_ver ?? null,
    deployed_fw_ver: newest.find((r) => r.fw_ver)?.fw_ver ?? null,
    deployed_at: version?.at ?? null,
    deployed_source: version?.source ?? null,
    installed_commit_id: commit?.id ?? null,
    installed_commit_at: commit?.r.at ?? null,
    installed_commit_source: commit?.r.source ?? null,
  };
}
