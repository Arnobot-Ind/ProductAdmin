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
  const [latest, setLatest] = useState<SoftwareLatestDto | null>(null);
  const q = useQuery({ queryKey: ['robot', robotId, 'software'], queryFn: () => api.get<SoftwareDto>(`/robots/${robotId}/software`) });
  const fetchLatest = useMutation({
    mutationFn: () => api.get<SoftwareLatestDto>(`/robots/${robotId}/software/latest`),
    onSuccess: setLatest,
    onError: toast.error,
  });
  const recordButton = can('robot.write') && (
    <span className="flex flex-wrap gap-2">
      <Button
        icon={<CloudDownload className="size-4" aria-hidden />}
        onClick={() => fetchLatest.mutate()}
        loading={fetchLatest.isPending}
        disabled={!robot.repo_url}
        title={robot.repo_url ? 'Find the newest version on GitHub' : 'Add the repository link first'}
      >
        Auto update
      </Button>
      <Button variant="primary" icon={<RefreshCcw className="size-4" aria-hidden />} onClick={() => setRecording(true)}>
        Record update
      </Button>
    </span>
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
          <p className="text-muted">No repository link yet. Add one to use Auto update.</p>
        )}
      </Card>
      <QueryView query={q}>
        {(sw) =>
          !sw.current ? (
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
                    { label: 'Software version', value: sw.current.sw_ver ? <Mono>{sw.current.sw_ver}</Mono> : null },
                    { label: 'Firmware version', value: sw.current.fw_ver ? <Mono>{sw.current.fw_ver}</Mono> : null },
                    {
                      label: 'Installed commit',
                      value: sw.installed_commit_id ? (
                        <span>
                          <CommitLink repoUrl={robot.repo_url} id={sw.installed_commit_id} />
                          <span className="block text-xs text-muted">
                            Recorded <Time iso={sw.installed_commit_at} />
                          </span>
                        </span>
                      ) : null,
                    },
                    {
                      label: 'Last update',
                      value: (
                        <span>
                          <Time iso={sw.last_update_at} />
                          <span className="block text-xs text-muted">
                            {sw.current.source === 'manual' ? `Recorded by ${sw.current.entered_by_name ?? 'an admin'}` : 'Reported by the robot'}
                          </span>
                        </span>
                      ),
                    },
                    {
                      label: 'Enabled features',
                      value: sw.current.enabled_features?.length ? (
                        <span className="flex flex-wrap gap-1">
                          {sw.current.enabled_features.map((f) => (
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
      <RecordUpdateDialog robotId={robotId} open={recording} onClose={() => setRecording(false)} current={q.data?.current ?? null} installedCommit={q.data?.installed_commit_id ?? null} />
      <RepoDialog robot={robot} open={editingRepo} onClose={() => setEditingRepo(false)} />
      <AutoUpdateDialog robotId={robotId} latest={latest} onClose={() => setLatest(null)} current={q.data?.current ?? null} installedCommit={q.data?.installed_commit_id ?? null} />
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
      <Field label="Git repository link" hint="Leave empty to remove the link. Auto update works with github.com links.">
        <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/Arnobot-Ind/…" spellCheck={false} data-autofocus />
      </Field>
    </Dialog>
  );
}

/** Shows what GitHub has against what is recorded. Saving only updates the record: nothing is installed on the robot. */
function AutoUpdateDialog({ robotId, latest, onClose, current, installedCommit }: { robotId: string; latest: SoftwareLatestDto | null; onClose: () => void; current: SoftwareDto['current']; installedCommit: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const upToDate = !!latest && !!installedCommit && latest.commit_id.startsWith(installedCommit);
  const m = useMutation({
    mutationFn: () =>
      api.post<SoftwareDto>(`/robots/${robotId}/software`, {
        sw_ver: latest!.version ?? current?.sw_ver ?? null,
        fw_ver: current?.fw_ver ?? null,
        commit_id: latest!.commit_id,
        enabled_features: current?.enabled_features ?? [],
        note: 'Auto update: latest from GitHub',
      }),
    onSuccess: (data) => {
      qc.setQueryData(['robot', robotId, 'software'], data);
      void qc.invalidateQueries({ queryKey: ['robot', robotId] });
      toast.success('Saved as the installed version');
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!latest}
      onClose={onClose}
      title={upToDate ? 'Already up to date' : 'New version found'}
      description={upToDate ? 'The recorded commit is the newest one on GitHub.' : 'Saving records this as the installed version. It does not install anything on the robot.'}
      footer={
        upToDate ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>
              Save as installed
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
            { label: 'Installed now', value: installedCommit ? <CommitLink repoUrl={latest.repo_url} id={installedCommit} /> : current?.sw_ver ? <Mono>{current.sw_ver}</Mono> : 'Not recorded' },
            { label: 'What changed', value: latest.message },
          ]}
        />
      )}
    </Dialog>
  );
}

function RecordUpdateDialog({ robotId, open, onClose, current, installedCommit }: { robotId: string; open: boolean; onClose: () => void; current: SoftwareDto['current']; installedCommit: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sw, setSw] = useState('');
  const [fw, setFw] = useState('');
  const [commit, setCommit] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  const [newFeature, setNewFeature] = useState('');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  // Start from what the robot runs now: change only what was updated.
  useEffect(() => {
    if (!open) return;
    setSw(current?.sw_ver ?? '');
    setFw(current?.fw_ver ?? '');
    setCommit(installedCommit ?? '');
    setFeatures(current?.enabled_features ?? []);
    setNewFeature('');
    setWhen(toLocalInput(new Date().toISOString()));
    setNote('');
  }, [open, current, installedCommit]);

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
  const commitValue = commit.trim().toLowerCase();
  const commitBad = !!commitValue && !/^[0-9a-f]{7,64}$/.test(commitValue);
  const unchanged =
    !!current && (current.sw_ver ?? '') === sw.trim() && (current.fw_ver ?? '') === fw.trim() && (!commitValue || !!installedCommit?.startsWith(commitValue)) && JSON.stringify(current.enabled_features ?? []) === JSON.stringify([...features].sort());

  const m = useMutation({
    mutationFn: () =>
      api.post<SoftwareDto>(`/robots/${robotId}/software`, {
        sw_ver: sw.trim() || null,
        fw_ver: fw.trim() || null,
        commit_id: commitValue || null,
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
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={commitBad || (unchanged && !newFeature.trim())}>
            Save update
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Software version" hint={current?.sw_ver ? `Now ${current.sw_ver}` : 'e.g. 2.4.1'}>
          <Input value={sw} onChange={(e) => setSw(e.target.value)} spellCheck={false} data-autofocus />
        </Field>
        <Field label="Firmware version" hint={current?.fw_ver ? `Now ${current.fw_ver}` : 'e.g. 1.9.0'}>
          <Input value={fw} onChange={(e) => setFw(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Commit" hint={installedCommit ? `Now ${installedCommit.slice(0, 7)}` : 'The commit id from GitHub, e.g. 7fd1a60'} error={commitBad ? 'A commit id has 7 to 64 letters a-f and digits.' : undefined} className="sm:col-span-2">
          <Input value={commit} onChange={(e) => setCommit(e.target.value)} spellCheck={false} className="font-mono" />
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
            <InlineAlert tone="accent">Change a version, the commit or a feature to record an update.</InlineAlert>
          </div>
        )}
      </div>
    </Dialog>
  );
}
