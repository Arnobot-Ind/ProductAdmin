'use client';

import type { AttachmentDetailDto, DocumentDto, RobotAttachmentDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FitAttachmentDialog } from '@/components/domain/attachment-fit';
import { AttachmentDialog } from '@/components/domain/attachments-catalog';
import { DocumentsPanel, type OwnerOption } from '@/components/domain/documents-panel';
import { RevisionsCard } from '@/components/domain/hardware-revisions';
import { ProductMediaCard } from '@/components/domain/product-media';
import { RobotRef } from '@/components/domain/robot-ref';
import { CategoryBadge } from '@/components/domain/status';
import { BesideBack } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Card, EmptyState, KeyValue, Mono, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtWhen } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

export default function AttachmentPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['attachment', id], queryFn: () => api.get<AttachmentDetailDto>(`/attachments/${id}`) });
  return <QueryView query={q}>{(a) => <AttachmentView a={a} />}</QueryView>;
}

/**
 * One attachment, with the same records as a base model: details, photos / 3D, the robots it is (and was) fitted
 * on, hardware revisions with their main components, and documents.
 */
function AttachmentView({ a }: { a: AttachmentDetailDto }) {
  useDocumentTitle(a.name);
  const can = useCan();
  const canWrite = can('catalog.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const docs = useQuery({ queryKey: ['attachment', a.id, 'documents'], queryFn: () => api.get<DocumentDto[]>(`/attachments/${a.id}/documents`) });
  const owners: OwnerOption[] = [
    { label: `${a.name} (all revisions)`, owner: { attachment_id: a.id } },
    ...a.revisions.filter((r) => !r.deleted_at).map((r) => ({ label: `${a.name} ${r.name}`, owner: { hardware_revision_id: r.id } })),
  ];
  const retire = useMutation({
    mutationFn: () => (a.deleted_at ? api.post(`/attachments/${a.id}/restore`) : api.del(`/attachments/${a.id}`)),
    onSuccess: () => {
      toast.success(a.deleted_at ? `${a.name} brought back` : `${a.name} retired`);
      setRetiring(false);
      void qc.invalidateQueries({ queryKey: ['attachment', a.id] });
      void qc.invalidateQueries({ queryKey: ['attachments'] });
    },
    onError: toast.error,
  });

  return (
    <>
      <BesideBack>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/products" className="hover:underline">
            Base models &amp; attachments
          </Link>{' '}
          / <span aria-current="page">{a.name}</span>
        </nav>
      </BesideBack>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.name}
            {a.category ? (
              <CategoryBadge category={a.category} />
            ) : (
              <span className="flex gap-1.5">
                <CategoryBadge category="ugv" />
                <CategoryBadge category="uav" />
              </span>
            )}
            {a.deleted_at && <Badge tone="fault">Retired</Badge>}
          </span>
        }
        description={a.description ?? 'Attachment: equipment fitted on a vehicle.'}
        actions={
          canWrite ? (
            <>
              {!a.deleted_at && (
                <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              <Button
                variant="ghost"
                icon={a.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                onClick={() => (a.deleted_at ? retire.mutate() : setRetiring(true))}
                disabled={!a.deleted_at && a.robot_count > 0}
                title={!a.deleted_at && a.robot_count > 0 ? 'Remove it from its robots first' : undefined}
              >
                {a.deleted_at ? 'Bring back' : 'Retire'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-6">
        <Card title="Attachment">
          <KeyValue
            columns={3}
            items={[
              { label: 'Fits', value: a.category === 'uav' ? 'UAV · aerial robots' : a.category === 'ugv' ? 'UGV · ground robots' : 'UGV and UAV' },
              { label: 'Manufacturer', value: a.manufacturer },
              { label: 'Model / part number', value: a.model_number ? <Mono>{a.model_number}</Mono> : null },
              {
                label: 'Software repository',
                value: a.repo_url ? (
                  <a href={a.repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent-text hover:underline">
                    {a.repo_url} <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                  </a>
                ) : null,
              },
              {
                label: 'Fitted now',
                value: (
                  <Link href={`/robots?attachment=${a.id}`} className="text-accent-text hover:underline">
                    {a.robot_count} robot{a.robot_count === 1 ? '' : 's'}
                  </Link>
                ),
              },
              { label: 'Added', value: fmtWhen(a.created_at) },
            ]}
          />
        </Card>

        <ProductMediaCard owner="attachments" productId={a.id} name={a.name} />

        <AttachmentRobots a={a} />

        <RevisionsCard owner="attachments" ownerId={a.id} revisions={a.revisions} readOnly={!!a.deleted_at} />

        <Card title="Documents">
          <QueryView query={docs}>
            {(list) => (
              <DocumentsPanel
                documents={list}
                invalidateKey={['attachment', a.id, 'documents']}
                owners={a.deleted_at ? [] : owners}
                emptyText="No documents yet: add its manual, circuit diagram, BOM … Robots that carry it show them too."
              />
            )}
          </QueryView>
        </Card>
      </div>

      {editing && <AttachmentDialog value={a} category={a.category ?? 'ugv'} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={retiring}
        onClose={() => setRetiring(false)}
        onConfirm={() => retire.mutate()}
        loading={retire.isPending}
        danger
        title={`Retire ${a.name}?`}
        description="It can no longer be fitted. Its history, photos and documents are kept, and it can be brought back."
        confirmLabel="Retire"
      />
    </>
  );
}

/** The robots this attachment is fitted on now, and every robot it was fitted on before (which unit, when). */
function AttachmentRobots({ a }: { a: AttachmentDetailDto }) {
  const can = useCan();
  const qc = useQueryClient();
  const [fitting, setFitting] = useState(false);
  const q = useQuery({ queryKey: ['attachment', a.id, 'fittings'], queryFn: () => api.get<RobotAttachmentDto[]>(`/attachments/${a.id}/fittings`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['attachment', a.id] });
    void qc.invalidateQueries({ queryKey: ['attachments'] });
    void qc.invalidateQueries({ queryKey: ['robots'] });
    void qc.invalidateQueries({ queryKey: ['robot'] });
  };
  const unitColumns = [
    { key: 'rev', header: 'Revision', cell: (f: RobotAttachmentDto) => f.revision_name ?? <span className="text-muted">—</span> },
    { key: 'sn', header: 'Serial number', cell: (f: RobotAttachmentDto) => (f.serial_number ? <Mono>{f.serial_number}</Mono> : <span className="text-muted">—</span>) },
  ];
  return (
    <Card
      title="Robots"
      actions={
        can('robot.write') && !a.deleted_at ? (
          <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setFitting(true)}>
            Fit on a robot
          </Button>
        ) : undefined
      }
    >
      <QueryView query={q} rows={3}>
        {(list) => {
          const now = list.filter((f) => !f.removed_at);
          const past = list.filter((f) => f.removed_at);
          return (
            <div className="flex flex-col gap-5">
              <section aria-labelledby="att-now">
                <h3 id="att-now" className="mb-2 text-lg font-semibold">
                  Fitted now <span className="text-base font-normal text-muted">· {now.length}</span>
                </h3>
                {now.length === 0 ? (
                  <EmptyState title="Not fitted on any robot" description="Fit it here, or from a robot's page under Hardware → Attachments." />
                ) : (
                  <DataTable
                    caption={`Robots with ${a.name} fitted now`}
                    dense
                    rows={now}
                    rowKey={(f) => f.id}
                    columns={[
                      { key: 'robot', header: 'Robot', rowHeader: true, cell: (f) => <RobotRef id={f.robot_id} /> },
                      ...unitColumns,
                      { key: 'fitted', header: 'Fitted', cell: (f) => `${fmtWhen(f.fitted_at)}${f.fitted_by_name ? ` · ${f.fitted_by_name}` : ''}` },
                      { key: 'notes', header: 'Note', cell: (f) => f.notes ?? <span className="text-muted">—</span> },
                    ]}
                  />
                )}
              </section>
              {past.length > 0 && (
                <section aria-labelledby="att-past" className="border-t border-border pt-5">
                  <h3 id="att-past" className="mb-2 text-lg font-semibold">
                    Fitted before <span className="text-base font-normal text-muted">· {past.length}</span>
                  </h3>
                  <DataTable
                    caption={`Robots that had ${a.name} fitted before`}
                    dense
                    rows={past}
                    rowKey={(f) => f.id}
                    columns={[
                      { key: 'robot', header: 'Robot', rowHeader: true, cell: (f) => <RobotRef id={f.robot_id} /> },
                      ...unitColumns,
                      { key: 'when', header: 'Fitted → removed', cell: (f) => `${fmtWhen(f.fitted_at)} → ${fmtWhen(f.removed_at)}` },
                      { key: 'why', header: 'Why removed', cell: (f) => f.removal_note ?? <span className="text-muted">—</span> },
                    ]}
                  />
                </section>
              )}
            </div>
          );
        }}
      </QueryView>
      {fitting && <FitAttachmentDialog attachment={a} onClose={() => setFitting(false)} onDone={refresh} />}
    </Card>
  );
}
