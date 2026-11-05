'use client';

import type { RobotDeploymentDto, SiteDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinned, MoveRight, Square } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DeployDialog, MapLink, sitePlace } from '@/components/domain/sites';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, EmptyState, KeyValue, QueryView } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtWhen, fromLocalInput, toLocalInput } from '@/lib/format';

/** How long a deployment lasted (or has lasted so far), in days. */
function duration(from: string, to: string | null) {
  const days = Math.max(0, Math.floor(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 86_400_000));
  return days === 0 ? 'less than a day' : `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Records → Deployment: where the robot works now (site, address, contact, map) and every site it was at before,
 * with dates. Deploying elsewhere closes the current period; nothing is erased.
 */
export function DeploymentTab({ robotId, deleted }: { robotId: string; deleted: boolean }) {
  const can = useCan();
  const canWrite = can('robot.write') && !deleted;
  const qc = useQueryClient();
  const toast = useToast();
  const [deploying, setDeploying] = useState(false);
  const [ending, setEnding] = useState<RobotDeploymentDto | null>(null);
  const [endWhen, setEndWhen] = useState('');
  const [endNote, setEndNote] = useState('');
  const q = useQuery({ queryKey: ['robot', robotId, 'deployments'], queryFn: () => api.get<RobotDeploymentDto[]>(`/robots/${robotId}/deployments`) });
  const now = q.data?.find((d) => !d.ended_at) ?? null;
  const site = useQuery({ queryKey: ['site', now?.site_id], queryFn: () => api.get<SiteDto>(`/sites/${now!.site_id}`), enabled: !!now });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['robot', robotId] });
    void qc.invalidateQueries({ queryKey: ['robots'] });
    void qc.invalidateQueries({ queryKey: ['sites'] });
    void qc.invalidateQueries({ queryKey: ['site'] });
  };
  const end = useMutation({
    mutationFn: (d: RobotDeploymentDto) => api.post(`/robot-deployments/${d.id}/end`, { ended_at: endWhen ? fromLocalInput(endWhen) : undefined, note: endNote.trim() || null }),
    onSuccess: () => {
      toast.success('Deployment ended (kept in the history)');
      setEnding(null);
      setEndNote('');
      refresh();
    },
    onError: toast.error,
  });

  return (
    <QueryView query={q} rows={4}>
      {(list) => {
        const past = list.filter((d) => d.ended_at);
        const s = site.data;
        return (
          <div className="flex flex-col gap-5">
            <Card
              title="Deployed now"
              actions={
                canWrite ? (
                  <span className="flex flex-wrap gap-2">
                    {now && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Square className="size-4" aria-hidden />}
                        onClick={() => {
                          setEndWhen(toLocalInput(new Date().toISOString()));
                          setEnding(now);
                        }}
                      >
                        End deployment
                      </Button>
                    )}
                    <Button size="sm" variant="primary" icon={now ? <MoveRight className="size-4" aria-hidden /> : <MapPinned className="size-4" aria-hidden />} onClick={() => setDeploying(true)}>
                      {now ? 'Move to another site' : 'Deploy at a site'}
                    </Button>
                  </span>
                ) : undefined
              }
            >
              {!now ? (
                <EmptyState icon={<MapPinned className="size-8" />} title="Not deployed" description="Record the site this robot works at, so its location and contact person are always at hand." />
              ) : (
                <>
                  <p className="mb-3 flex flex-wrap items-center gap-2 text-lg font-semibold">
                    <span>{now.site_name}</span>
                    <Badge tone="ok">Since {fmtWhen(now.deployed_at)}</Badge>
                    <span className="text-sm font-normal text-muted">{duration(now.deployed_at, null)}</span>
                  </p>
                  <KeyValue
                    columns={3}
                    items={[
                      { label: 'What it does there', value: now.purpose },
                      { label: 'Whose site', value: s?.company_name },
                      { label: 'Place', value: s ? sitePlace(s) || null : null },
                      { label: 'Address', value: s?.address },
                      {
                        label: 'Contact on site',
                        value: s?.contact_name || s?.contact_phone || s?.contact_email ? (
                          <span className="block">
                            {s?.contact_name}
                            {s?.contact_phone && (
                              <a href={`tel:${s.contact_phone}`} className="block text-accent-text hover:underline">
                                {s.contact_phone}
                              </a>
                            )}
                            {s?.contact_email && (
                              <a href={`mailto:${s.contact_email}`} className="block break-all text-accent-text hover:underline">
                                {s.contact_email}
                              </a>
                            )}
                          </span>
                        ) : null,
                      },
                      { label: 'Map', value: s ? <MapLink site={s} /> : null },
                      { label: 'Deployed by', value: now.deployed_by_name },
                      { label: 'Note', value: now.notes },
                    ]}
                  />
                </>
              )}
            </Card>

            <Card title={`Deployed before (${past.length})`} bodyClassName="p-0">
              {past.length === 0 ? (
                <p className="p-5 text-base text-muted">No earlier deployments.</p>
              ) : (
                <ol className="divide-y divide-border">
                  {past.map((d) => (
                    <li key={d.id} className="px-5 py-3">
                      <span className="font-semibold">{d.site_name}</span>
                      {d.site_city && <span className="text-muted"> · {d.site_city}</span>}
                      <span className="block text-sm text-muted">
                        {fmtWhen(d.deployed_at)} → {fmtWhen(d.ended_at)} · {duration(d.deployed_at, d.ended_at)}
                        {d.purpose ? ` · ${d.purpose}` : ''}
                        {d.end_note ? ` · ${d.end_note}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            {deploying && <DeployDialog robotId={robotId} current={now} onClose={() => setDeploying(false)} onDone={refresh} />}
            <ConfirmDialog
              open={!!ending}
              onClose={() => setEnding(null)}
              onConfirm={() => ending && end.mutate(ending)}
              loading={end.isPending}
              title={`End the deployment at ${ending?.site_name ?? ''}?`}
              description="The robot is then shown as not deployed. The period stays in its history."
              confirmLabel="End deployment"
            >
              <div className="grid gap-3">
                <Field label="Ended on">
                  <Input type="datetime-local" value={endWhen} max={toLocalInput(new Date().toISOString())} onChange={(e) => setEndWhen(e.target.value)} />
                </Field>
                <Field label="Why (optional)">
                  <Input value={endNote} onChange={(e) => setEndNote(e.target.value)} placeholder="e.g. Back to workshop for service" maxLength={500} />
                </Field>
              </div>
            </ConfirmDialog>
          </div>
        );
      }}
    </QueryView>
  );
}
