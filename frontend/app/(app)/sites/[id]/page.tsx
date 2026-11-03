'use client';

import type { RobotDeploymentDto, SiteDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinned, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RobotRef } from '@/components/domain/robot-ref';
import { DeployDialog, MapLink, SiteDialog, sitePlace } from '@/components/domain/sites';
import { BesideBack } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Card, EmptyState, KeyValue, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtWhen } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { fmtSiteNo } from '@/lib/format';

export default function SitePage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['site', id], queryFn: () => api.get<SiteDto>(`/sites/${id}`) });
  return <QueryView query={q}>{(s) => <SiteView s={s} />}</QueryView>;
}

const days = (from: string, to: string | null) => Math.max(0, Math.floor(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 86_400_000));

/** One site: where it is, whose it is, who to call there, and every robot deployed there now and before. */
function SiteView({ s }: { s: SiteDto }) {
  useDocumentTitle(s.name);
  const can = useCan();
  const canWrite = can('robot.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const deployments = useQuery({ queryKey: ['site', s.id, 'deployments'], queryFn: () => api.get<RobotDeploymentDto[]>(`/sites/${s.id}/deployments`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['site', s.id] });
    void qc.invalidateQueries({ queryKey: ['sites'] });
    void qc.invalidateQueries({ queryKey: ['robots'] });
    void qc.invalidateQueries({ queryKey: ['robot'] });
  };
  const retire = useMutation({
    mutationFn: () => (s.deleted_at ? api.post(`/sites/${s.id}/restore`) : api.del(`/sites/${s.id}`)),
    onSuccess: () => {
      toast.success(s.deleted_at ? `${s.name} brought back` : `${s.name} retired`);
      setRetiring(false);
      refresh();
    },
    onError: toast.error,
  });

  return (
    <>
      <BesideBack>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/sites" className="hover:underline">
            Sites
          </Link>{' '}
          / <span aria-current="page">{s.name}</span>
        </nav>
      </BesideBack>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.name} <span className="font-mono text-lg font-normal text-muted">{fmtSiteNo(s.org_no, s.site_no)}</span> {s.deleted_at && <Badge tone="fault">Retired</Badge>}
          </span>
        }
        description={[sitePlace(s), s.company_name].filter(Boolean).join(' · ') || undefined}
        actions={
          canWrite ? (
            <>
              {!s.deleted_at && (
                <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              <Button
                variant="ghost"
                icon={s.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                onClick={() => (s.deleted_at ? retire.mutate() : setRetiring(true))}
                disabled={!s.deleted_at && s.robots_now > 0}
                title={!s.deleted_at && s.robots_now > 0 ? 'Move its robots first' : undefined}
              >
                {s.deleted_at ? 'Bring back' : 'Retire'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-6">
        <Card title="Site">
          <KeyValue
            columns={3}
            items={[
              { label: 'Whose site', value: s.company_name },
              { label: 'Address', value: s.address },
              { label: 'Place', value: [s.city, s.state, s.country].filter(Boolean).join(', ') || null },
              {
                label: 'Map',
                value: (
                  <span className="block">
                    {s.latitude !== null && <span className="block font-mono text-sm">{s.latitude}, {s.longitude}</span>}
                    <MapLink site={s} />
                  </span>
                ),
              },
              {
                label: 'Contact on site',
                value:
                  s.contact_name || s.contact_phone || s.contact_email ? (
                    <span className="block">
                      {s.contact_name}
                      {s.contact_phone && (
                        <a href={`tel:${s.contact_phone}`} className="block text-accent-text hover:underline">
                          {s.contact_phone}
                        </a>
                      )}
                      {s.contact_email && (
                        <a href={`mailto:${s.contact_email}`} className="block break-all text-accent-text hover:underline">
                          {s.contact_email}
                        </a>
                      )}
                    </span>
                  ) : null,
              },
              { label: 'Robots', value: `${s.robots_now} now · ${s.robots_ever} ever` },
              { label: 'Notes', value: s.notes ? <span className="whitespace-pre-line">{s.notes}</span> : null },
              { label: 'Added', value: fmtWhen(s.created_at) },
            ]}
          />
        </Card>

        <Card
          title="Robots"
          actions={
            canWrite && !s.deleted_at ? (
              <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setDeploying(true)}>
                Deploy a robot here
              </Button>
            ) : undefined
          }
        >
          <QueryView query={deployments} rows={3}>
            {(list) => {
              const now = list.filter((d) => !d.ended_at);
              const past = list.filter((d) => d.ended_at);
              return (
                <div className="flex flex-col gap-5">
                  <section aria-labelledby="site-now">
                    <h3 id="site-now" className="mb-2 text-lg font-semibold">
                      Deployed now <span className="text-base font-normal text-muted">· {now.length}</span>
                    </h3>
                    {now.length === 0 ? (
                      <EmptyState icon={<MapPinned className="size-8" />} title="No robot here now" description="Deploy one here, or from a robot's page (Records → Deployment)." />
                    ) : (
                      <DataTable
                        caption={`Robots at ${s.name} now`}
                        compact
                        rows={now}
                        rowKey={(d) => d.id}
                        columns={[
                          { key: 'robot', header: 'Robot', rowHeader: true, cell: (d) => <RobotRef id={d.robot_id} /> },
                          { key: 'since', header: 'Since', cell: (d) => `${fmtWhen(d.deployed_at)} · ${days(d.deployed_at, null)} d` },
                          { key: 'purpose', header: 'What it does', cell: (d) => d.purpose ?? <span className="text-muted">—</span> },
                          { key: 'by', header: 'Deployed by', className: 'hidden md:table-cell', cell: (d) => d.deployed_by_name ?? <span className="text-muted">—</span> },
                        ]}
                      />
                    )}
                  </section>
                  {past.length > 0 && (
                    <section aria-labelledby="site-past" className="border-t border-border pt-5">
                      <h3 id="site-past" className="mb-2 text-lg font-semibold">
                        Here before <span className="text-base font-normal text-muted">· {past.length}</span>
                      </h3>
                      <DataTable
                        caption={`Robots that were at ${s.name} before`}
                        compact
                        rows={past}
                        rowKey={(d) => d.id}
                        columns={[
                          { key: 'robot', header: 'Robot', rowHeader: true, cell: (d) => <RobotRef id={d.robot_id} /> },
                          { key: 'when', header: 'From → to', cell: (d) => `${fmtWhen(d.deployed_at)} → ${fmtWhen(d.ended_at)} · ${days(d.deployed_at, d.ended_at)} d` },
                          { key: 'why', header: 'Why it left', cell: (d) => d.end_note ?? <span className="text-muted">—</span> },
                        ]}
                      />
                    </section>
                  )}
                </div>
              );
            }}
          </QueryView>
        </Card>
      </div>

      {editing && <SiteDialog value={s} onClose={() => setEditing(false)} />}
      {deploying && <DeployDialog site={s} onClose={() => setDeploying(false)} onDone={refresh} />}
      <ConfirmDialog
        open={retiring}
        onClose={() => setRetiring(false)}
        onConfirm={() => retire.mutate()}
        loading={retire.isPending}
        danger
        title={`Retire ${s.name}?`}
        description="No robot can be deployed here any more. Its history is kept, and it can be brought back."
        confirmLabel="Retire"
      />
    </>
  );
}
