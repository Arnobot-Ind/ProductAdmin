'use client';

import type { RobotDetailDto, SoftwareDto, SoftwareLatestDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, ExternalLink, GitBranch, Pencil, Plus, RefreshCcw, X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, InlineAlert, KeyValue, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fromLocalInput, toLocalInput } from '@/lib/format';

/**
 * Spec §3 row 4: reported by the robot at boot (`hello`), or recorded here by an admin (e.g. after flashing a
 * robot that is offline). Every change is a new history row; nothing is overwritten.
 */
export function SoftwareTab({ robot }: { robot: RobotDetailDto }) {
  const robotId = robot.robot_id;
  const can = useCan();
  const toast = useToast();
  const [recording, setRecording] = useState(false);
  const [editingRepo, setEditingRepo] = useState(false);
  const [editingCommit, setEditingCommit] = useState(false);
  const [latest, setLatest] = useState<SoftwareLatestDto | null>(null);
  const q = useQuery({ queryKey: ['robot', robotId, 'software'], queryFn: () => api.get<SoftwareDto>(`/robots/${robotId}/software`) });
  const fetchLatest = useMutation({
    mutationFn: () => api.get<SoftwareLatestDto>(`/robots/${robotId}/software/latest`),
    onSuccess: setLatest,
    onError: toast.error,
  });
  const recordButton = can('robot.write') && (
    <Button variant="primary" icon={<RefreshCcw className="size-4" aria-hidden />} onClick={() => setRecording(true)}>
      Record update
    </Button>
  );
  return (
    <>
      <Card
        title="Repository"
        className="mb-6"
        actions={
          can('catalog.write') ? (
            <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditingRepo(true)}>
              {robot.repo_url ? 'Edit link' : 'Add link'}
            </Button>
          ) : undefined
        }
      >
        {robot.repo_url ? (
          <a href={robot.repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-base font-medium break-all hover:underline">
            <GitBranch className="size-4 shrink-0" aria-hidden /> {robot.repo_url} <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
        ) : (
          <p className="text-muted">No repository link yet. Add one to fetch the latest commit.</p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <p className="text-sm text-muted">Commit id</p>
            {q.data?.installed_commit_id ? (
              <>
                <p className="text-lg font-medium">
                  <CommitLink repoUrl={robot.repo_url} id={q.data.installed_commit_id} />
                </p>
                <p className="text-sm text-muted">
                  {q.data.installed_commit_source === 'manual' ? 'Saved' : 'Last reported by the robot'} <Time iso={q.data.installed_commit_at} />
                </p>
              </>
            ) : (
              <p className="text-lg text-muted">No commit id yet</p>
            )}
          </div>
          {can('robot.write') && !robot.deleted_at && (
            <div className="flex flex-wrap gap-2">
              <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditingCommit(true)}>
                Edit commit
              </Button>
              <Button
                icon={<CloudDownload className="size-4" aria-hidden />}
                onClick={() => fetchLatest.mutate()}
                loading={fetchLatest.isPending}
                disabled={!robot.repo_url}
                title={robot.repo_url ? 'Find the newest commit on GitHub' : 'Add the repository link first'}
              >
                Fetch latest commit
              </Button>
            </div>
          )}
        </div>
      </Card>
      <QueryView query={q}>
        {(sw) =>
          !sw.current && !sw.deployed_version ? (
            <EmptyState
              title="No software recorded yet"
              description="The robot reports its software and firmware versions at boot and after every reconnect. You can also record them here."
              action={recordButton || undefined}
            />
          ) : (
            <div className="flex flex-col gap-6">
              <Card title="Current" actions={recordButton || undefined}>
                <KeyValue
                  columns={3}
                  items={[
                    {
                      label: 'Deployed version',
                      value: sw.deployed_version ? (
                        <span>
                          <Mono>{sw.deployed_version}</Mono>
                          <span className="block text-xs text-muted">
                            {sw.deployed_source === 'manual' ? 'Saved' : 'Last reported by the robot'} <Time iso={sw.deployed_at} />
                          </span>
                        </span>
                      ) : null,
                    },
                    { label: 'Firmware version', value: sw.deployed_fw_ver ? <Mono>{sw.deployed_fw_ver}</Mono> : null },
                    {
                      label: 'Last update',
                      value: (
                        <span>
                          <Time iso={sw.last_update_at} />
                          <span className="block text-xs text-muted">
                            {sw.current?.source === 'manual' ? `Recorded by ${sw.current.entered_by_name ?? 'an admin'}` : 'Reported by the robot'}
                          </span>
                        </span>
                      ),
                    },
                    {
                      label: 'Enabled features',
                      value: sw.current?.enabled_features?.length ? (
                        <span className="flex flex-wrap gap-1">
                          {sw.current?.enabled_features?.map((f) => (
                            <Badge key={f} tone="accent">
                              {f}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        'None'
                      ),
                    },
                  ]}
                />
              </Card>
              <section aria-labelledby="sw-history">
                <h2 id="sw-history" className="mb-2 text-sm font-semibold">
                  Update history
                </h2>
                <DataTable
                  caption="Software update history"
                  rows={sw.history}
                  rowKey={(h) => h.id}
                  columns={[
                    { key: 'at', header: 'When', rowHeader: true, cell: (h) => <Time iso={h.reported_at} /> },
                    { key: 'sw', header: 'Software', cell: (h) => (h.sw_ver ? <Mono>{h.sw_ver}</Mono> : '—') },
                    { key: 'fw', header: 'Firmware', cell: (h) => (h.fw_ver ? <Mono>{h.fw_ver}</Mono> : '—') },
                    { key: 'commit', header: 'Commit', cell: (h) => (h.commit_id ? <CommitLink repoUrl={robot.repo_url} id={h.commit_id} /> : '—') },
                    { key: 'feat', header: 'Features', cell: (h) => h.enabled_features?.join(', ') || '—' },
                    {
                      key: 'src',
                      header: 'Source',
                      cell: (h) =>
                        h.source === 'manual' ? (
                          <span>
                            <Badge>Recorded by {h.entered_by_name ?? 'admin'}</Badge>
                            {h.note && <span className="mt-0.5 block text-xs text-muted">{h.note}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">Robot{h.boot_id ? <> · boot <span className="font-mono">{h.boot_id.slice(0, 8)}</span></> : null}</span>
                        ),
                    },
                  ]}
                />
              </section>
            </div>
          )
        }
      </QueryView>
      <RecordUpdateDialog robotId={robotId} open={recording} onClose={() => setRecording(false)} current={q.data?.current ?? null} deployed={q.data ?? null} />
      <RepoDialog robot={robot} open={editingRepo} onClose={() => setEditingRepo(false)} />
      <CommitDialog robotId={robotId} open={editingCommit} onClose={() => setEditingCommit(false)} sw={q.data ?? null} />
      <AutoUpdateDialog robotId={robotId} latest={latest} onClose={() => setLatest(null)} current={q.data?.current ?? null} deployed={q.data ?? null} installedCommit={q.data?.installed_commit_id ?? null} />
    </>
  );
}

/** A short commit id, linked to the commit when the repository is on GitHub. */
function CommitLink({ repoUrl, id }: { repoUrl: string | null; id: string }) {
  const repo = repoUrl && /^https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/i.exec(repoUrl)?.[0].replace(/\.git$/i, '');
  const short = <Mono>{id.slice(0, 7)}</Mono>;
  return repo ? (
    <a href={`${repo}/commit/${id}`} target="_blank" rel="noopener noreferrer" title={id} className="hover:underline">
      {short}
    </a>
  ) : (
    <span title={id}>{short}</span>
  );
}

/** A version made of a commit ("git-0076906") follows the commit; a real version number stays as it is. */
const versionForCommit = (version: string | null | undefined, commitId: string) => (!version || /^git-/i.test(version) ? `git-${commitId.slice(0, 7)}` : version);

/** Type the commit by hand. Saved in the history for this robot. */
function CommitDialog({ robotId, open, onClose, sw }: { robotId: string; open: boolean; onClose: () => void; sw: SoftwareDto | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [commit, setCommit] = useState('');
  useEffect(() => {
    if (open) setCommit(sw?.installed_commit_id ?? '');
  }, [open, sw?.installed_commit_id]);
  const value = commit.trim().toLowerCase();
  const bad = !/^[0-9a-f]{7,64}$/.test(value);
  const same = !!value && !!sw?.installed_commit_id?.startsWith(value);
  const m = useMutation({
    mutationFn: () =>
      api.post<SoftwareDto>(`/robots/${robotId}/software`, {
        sw_ver: versionForCommit(sw?.deployed_version, value),
        fw_ver: sw?.deployed_fw_ver ?? null,
        commit_id: value,
        enabled_features: sw?.current?.enabled_features ?? [],
        note: 'Commit id edited',
      }),
    onSuccess: (data) => {
      qc.setQueryData(['robot', robotId, 'software'], data);
      void qc.invalidateQueries({ queryKey: ['robot', robotId] });
      toast.success('Commit id saved');
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit commit id"
      description="The commit this robot runs. It does not change anything on the robot, and a newer report from the robot replaces it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={bad || same}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Commit id" hint="From GitHub, e.g. 7fd1a60" error={value && bad ? 'A commit id has 7 to 64 letters a-f and digits.' : undefined}>
        <Input value={commit} onChange={(e) => setCommit(e.target.value)} spellCheck={false} className="font-mono" data-autofocus />
      </Field>
    </Dialog>
  );
}

/** The link belongs to the base model, so every robot of that model shares it. */
function RepoDialog({ robot, open, onClose }: { robot: RobotDetailDto; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (open) setUrl(robot.repo_url ?? '');
  }, [open, robot.repo_url]);
  const m = useMutation({
    mutationFn: () => api.patch(`/products/${robot.product_id}`, { repo_url: url.trim() || null }),
    onSuccess: () => {
      toast.success('Repository link saved');
      void qc.invalidateQueries({ queryKey: ['robot', robot.robot_id] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
      void qc.invalidateQueries({ queryKey: ['product', robot.product_id] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Repository link"
      description={`The link belongs to the base model ${robot.product_name}, so every ${robot.product_name} robot uses it.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Git repository link" hint="Leave empty to remove the link. Fetching the latest commit works with github.com links.">
        <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/Arnobot-Ind/…" spellCheck={false} data-autofocus />
      </Field>
    </Dialog>
  );
}

/** Shows what GitHub has against what is recorded. Saving only updates the record: nothing is installed on the robot. */
function AutoUpdateDialog({ robotId, latest, onClose, current, deployed, installedCommit }: { robotId: string; latest: SoftwareLatestDto | null; onClose: () => void; current: SoftwareDto['current']; deployed: SoftwareDto | null; installedCommit: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const upToDate = !!latest && !!installedCommit && latest.commit_id.startsWith(installedCommit);
  const m = useMutation({
    mutationFn: () =>
      api.post<SoftwareDto>(`/robots/${robotId}/software`, {
        sw_ver: latest!.version ?? versionForCommit(deployed?.deployed_version, latest!.commit_id),
        fw_ver: deployed?.deployed_fw_ver ?? null,
        commit_id: latest!.commit_id,
        enabled_features: current?.enabled_features ?? [],
        note: 'Latest commit fetched from GitHub',
      }),
    onSuccess: (data) => {
      qc.setQueryData(['robot', robotId, 'software'], data);
      void qc.invalidateQueries({ queryKey: ['robot', robotId] });
      toast.success('Commit id saved');
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!latest}
      onClose={onClose}
      title={upToDate ? 'Already up to date' : 'Latest commit on GitHub'}
      description={upToDate ? 'The recorded commit is the newest one on GitHub.' : 'Saving records this as the commit this robot runs. It does not install anything on the robot, and a newer report from the robot replaces it.'}
      footer={
        upToDate ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>
              Save commit
            </Button>
          </>
        )
      }
    >
      {latest && (
        <KeyValue
          columns={2}
          items={[
            { label: 'Latest version', value: latest.version ? <Mono>{latest.version}</Mono> : `Newest commit on ${latest.branch}` },
            { label: 'Latest commit', value: <CommitLink repoUrl={latest.repo_url} id={latest.commit_id} /> },
            { label: 'Committed', value: <Time iso={latest.committed_at} /> },
            { label: 'Installed now', value: installedCommit ? <CommitLink repoUrl={latest.repo_url} id={installedCommit} /> : deployed?.deployed_version ? <Mono>{deployed.deployed_version}</Mono> : 'Not recorded' },
            { label: 'What changed', value: latest.message },
          ]}
        />
      )}
    </Dialog>
  );
}

function RecordUpdateDialog({ robotId, open, onClose, current, deployed }: { robotId: string; open: boolean; onClose: () => void; current: SoftwareDto['current']; deployed: SoftwareDto | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sw, setSw] = useState('');
  const [fw, setFw] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  const [newFeature, setNewFeature] = useState('');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  // Start from what the robot runs now: change only what was updated.
  useEffect(() => {
    if (!open) return;
    setSw(deployed?.deployed_version ?? '');
    setFw(deployed?.deployed_fw_ver ?? '');
    setFeatures(current?.enabled_features ?? []);
    setNewFeature('');
    setWhen(toLocalInput(new Date().toISOString()));
    setNote('');
  }, [open, current, deployed]);

  const addFeature = () => {
    const f = newFeature.trim();
    if (f && !features.includes(f)) setFeatures([...features, f].sort());
    setNewFeature('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addFeature();
    }
  };
  const unchanged =
    !!current && (deployed?.deployed_version ?? '') === sw.trim() && (deployed?.deployed_fw_ver ?? '') === fw.trim() && JSON.stringify(current.enabled_features ?? []) === JSON.stringify([...features].sort());

  const m = useMutation({
    mutationFn: () =>
      api.post<SoftwareDto>(`/robots/${robotId}/software`, {
        sw_ver: sw.trim() || null,
        fw_ver: fw.trim() || null,
        enabled_features: newFeature.trim() && !features.includes(newFeature.trim()) ? [...features, newFeature.trim()] : features,
        updated_at: fromLocalInput(when),
        note: note.trim() || null,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['robot', robotId, 'software'], data);
      toast.success('Software update recorded');
      onClose();
    },
    onError: toast.error,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record software update"
      description="Saves the new versions and features in the PMS history. It does not install anything on the robot."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={unchanged && !newFeature.trim()}>
            Save update
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Software version" hint={deployed?.deployed_version ? `Now ${deployed.deployed_version}` : 'e.g. 2.4.1'}>
          <Input value={sw} onChange={(e) => setSw(e.target.value)} spellCheck={false} data-autofocus />
        </Field>
        <Field label="Firmware version" hint={deployed?.deployed_fw_ver ? `Now ${deployed.deployed_fw_ver}` : 'e.g. 1.9.0'}>
          <Input value={fw} onChange={(e) => setFw(e.target.value)} spellCheck={false} />
        </Field>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium" id="features-label">
            Enabled features
          </span>
          <ul className="flex min-h-9 flex-wrap items-center gap-1.5" aria-labelledby="features-label">
            {features.length === 0 && <li className="text-sm text-muted">None</li>}
            {features.map((f) => (
              <li key={f}>
                <Badge tone="accent">
                  {f}
                  <button type="button" onClick={() => setFeatures(features.filter((x) => x !== f))} className="ml-0.5 rounded hover:text-fault" aria-label={`Disable ${f}`}>
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input value={newFeature} onChange={(e) => setNewFeature(e.target.value)} onKeyDown={onKey} placeholder="Add a feature, e.g. rtk_gps" aria-label="New feature" spellCheck={false} />
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={addFeature} disabled={!newFeature.trim()}>
              Add
            </Button>
          </div>
        </div>
        <Field label="Updated on" hint="When the update was installed">
          <Input type="datetime-local" value={when} max={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Note" hint="e.g. flashed over USB at the workshop" className="sm:col-span-2">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {unchanged && !newFeature.trim() && (
          <div className="sm:col-span-2">
            <InlineAlert tone="accent">Change a version or a feature to record an update.</InlineAlert>
          </div>
        )}
      </div>
    </Dialog>
  );
}
