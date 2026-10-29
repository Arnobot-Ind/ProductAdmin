'use client';

import type { RobotAttachmentDto, RobotCategory } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Puzzle, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FitAttachmentDialog } from '@/components/domain/attachment-fit';
import { useAttachments } from '@/components/domain/attachments-catalog';
import { mediaUrl } from '@/components/domain/product-media';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Card, EmptyState, QueryView } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtWhen } from '@/lib/format';

/**
 * Hardware → Attachments: what is fitted on this vehicle now, and everything fitted before (with dates), so the
 * history stays clear for years. Attachments themselves are defined once under Base models & attachments.
 */
export function AttachmentsTab({ robotId, category }: { robotId: string; category: RobotCategory }) {
  const can = useCan();
  const canWrite = can('robot.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [fitting, setFitting] = useState(false);
  const [removing, setRemoving] = useState<RobotAttachmentDto | null>(null);
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['robot', robotId, 'attachments'], queryFn: () => api.get<RobotAttachmentDto[]>(`/robots/${robotId}/attachments`) });
  const catalog = useAttachments(true);
  const cover = new Map((catalog.data ?? []).map((a) => [a.id, a.cover_photo_id]));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['robot', robotId] });
    void qc.invalidateQueries({ queryKey: ['robots'] });
    void qc.invalidateQueries({ queryKey: ['attachments'] });
    void qc.invalidateQueries({ queryKey: ['attachment'] });
  };
  const remove = useMutation({
    mutationFn: (a: RobotAttachmentDto) => api.post(`/robot-attachments/${a.id}/remove`, { note: note.trim() || null }),
    onSuccess: () => {
      toast.success('Attachment removed (kept in the history)');
      setRemoving(null);
      setNote('');
      refresh();
    },
    onError: toast.error,
  });
  return (
    <QueryView query={q} rows={4}>
      {(list) => {
        const now = list.filter((a) => !a.removed_at);
        const past = list.filter((a) => a.removed_at);
        return (
          <div className="flex flex-col gap-5">
            <Card
              title={`Fitted now (${now.length})`}
              actions={
                canWrite ? (
                  <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setFitting(true)}>
                    Fit attachment
                  </Button>
                ) : undefined
              }
              bodyClassName="p-0"
            >
              {now.length === 0 ? (
                <div className="p-5">
                  <EmptyState icon={<Puzzle className="size-8" />} title="No attachments fitted" description="Fit the equipment this vehicle carries (sprayer, thermal camera, arm …) so everyone sees it next to the robot." />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {now.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                      {cover.get(a.attachment_id) ? (
                        // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
                        <img src={mediaUrl(cover.get(a.attachment_id)!)} alt="" className="size-14 shrink-0 rounded-lg border border-border object-cover" />
                      ) : (
                        <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
                          <Puzzle className="size-6" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 basis-64">
                        <Link href={`/attachments/${a.attachment_id}`} className="block text-base font-semibold text-accent-text hover:underline">
                          {a.name}
                          {unit(a) && <span className="font-normal text-muted"> · {unit(a)}</span>}
                        </Link>
                        {a.description && <span className="block text-sm text-muted">{a.description}</span>}
                        <span className="block text-sm text-muted">
                          Fitted {fmtWhen(a.fitted_at)}
                          {a.fitted_by_name ? ` by ${a.fitted_by_name}` : ''}
                          {a.notes ? ` · ${a.notes}` : ''}
                        </span>
                      </span>
                      {canWrite && (
                        <Button size="sm" variant="ghost" icon={<Unplug className="size-4" aria-hidden />} onClick={() => setRemoving(a)}>
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {past.length > 0 && (
              <Card title="Fitted before" bodyClassName="p-0">
                <ul className="divide-y divide-border">
                  {past.map((a) => (
                    <li key={a.id} className="px-5 py-3 text-base">
                      <Link href={`/attachments/${a.attachment_id}`} className="font-semibold text-accent-text hover:underline">
                        {a.name}
                      </Link>
                      <span className="text-muted">
                        {unit(a) && ` · ${unit(a)}`} · {fmtWhen(a.fitted_at)} → {fmtWhen(a.removed_at)}
                        {a.removed_by_name ? ` (removed by ${a.removed_by_name})` : ''}
                        {a.removal_note ? ` · ${a.removal_note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {fitting && <FitAttachmentDialog robot={{ id: robotId, category, fitted: new Set(now.map((a) => a.attachment_id)) }} onClose={() => setFitting(false)} onDone={refresh} />}
            <ConfirmDialog
              open={!!removing}
              onClose={() => setRemoving(null)}
              onConfirm={() => removing && remove.mutate(removing)}
              loading={remove.isPending}
              title={`Remove ${removing?.name ?? ''}?`}
              description="It is no longer shown on the robot. The fitting stays in this robot's history."
              confirmLabel="Remove"
            >
              <Field label="Why (optional)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sent for repair" />
              </Field>
            </ConfirmDialog>
          </div>
        );
      }}
    </QueryView>
  );
}

/** The unit fitted: revision and serial number, when recorded. */
const unit = (a: RobotAttachmentDto) => [a.revision_name, a.serial_number ? `SN ${a.serial_number}` : null].filter(Boolean).join(' · ');
