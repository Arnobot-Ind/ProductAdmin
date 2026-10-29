'use client';

import type { AttachmentDetailDto, AttachmentDto, RobotCategory } from '@arnobot/message-schema';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RobotPicker } from '@/components/domain/robot-picker';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { fromLocalInput, toLocalInput } from '@/lib/format';

/**
 * Fit an attachment on a robot: which attachment (from a robot's page) or which robot (from an attachment's page),
 * which revision of the attachment and which unit (serial number), and when.
 */
export function FitAttachmentDialog({
  robot,
  attachment,
  onClose,
  onDone,
}: {
  /** From a robot's page: the robot, its category and what it already carries. */
  robot?: { id: string; category: RobotCategory; fitted: Set<string> };
  /** From an attachment's page. */
  attachment?: AttachmentDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const catalog = useQuery({ queryKey: ['attachments'], queryFn: () => api.get<AttachmentDto[]>('/attachments'), enabled: !attachment });
  const [attachmentId, setAttachmentId] = useState(attachment?.id ?? '');
  const [robotId, setRobotId] = useState(robot?.id ?? '');
  const [robotCategory, setRobotCategory] = useState<RobotCategory | null>(robot?.category ?? null);
  const [revision, setRevision] = useState('');
  const [serial, setSerial] = useState('');
  const [when, setWhen] = useState(toLocalInput(new Date().toISOString()));
  const [notes, setNotes] = useState('');
  const detail = useQuery({ queryKey: ['attachment', attachmentId], queryFn: () => api.get<AttachmentDetailDto>(`/attachments/${attachmentId}`), enabled: !!attachmentId });
  const revisions = detail.data?.revisions ?? [];
  const options = (catalog.data ?? []).filter((a) => !robot?.fitted.has(a.id) && (!a.category || a.category === robot?.category));
  const wrongCategory = !!attachment?.category && !!robotCategory && attachment.category !== robotCategory;
  const m = useMutation({
    mutationFn: () =>
      api.post(`/robots/${robotId}/attachments`, {
        attachment_id: attachmentId,
        hardware_revision_id: revision || null,
        serial_number: serial.trim() || null,
        fitted_at: fromLocalInput(when),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Attachment fitted');
      onDone();
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={robot ? `Fit an attachment on ${robot.id}` : `Fit ${attachment?.name ?? 'attachment'} on a robot`}
      description={robot ? 'Only attachments that fit this category are listed. Add new ones under Base models & attachments.' : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!attachmentId || !robotId || wrongCategory}>
            Fit
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {robot ? (
          <Field label="Attachment" required hint={catalog.data && !options.length ? 'No more attachments to fit. Add one under Base models & attachments.' : undefined}>
            <Select
              value={attachmentId}
              onChange={(e) => {
                setAttachmentId(e.target.value);
                setRevision('');
              }}
              data-autofocus
            >
              <option value="">Choose…</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.model_number ? ` (${a.model_number})` : ''}
                  {a.description ? ` · ${a.description}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Robot" required error={wrongCategory ? `${attachment?.name} fits ${attachment?.category?.toUpperCase()}s only` : null}>
            <RobotPicker
              value={robotId}
              autoFocus
              onChange={(id, r) => {
                setRobotId(id);
                setRobotCategory(r?.category ?? null);
              }}
            />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Revision" hint={attachmentId && detail.data && !revisions.length ? 'This attachment has no revisions yet.' : undefined}>
            <Select value={revision} onChange={(e) => setRevision(e.target.value)} disabled={!revisions.length}>
              <option value="">Not recorded</option>
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.description ? ` · ${r.description}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Serial number of this unit">
            <Input value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={100} placeholder="Optional" spellCheck={false} />
          </Field>
        </div>
        <Field label="Fitted on">
          <Input type="datetime-local" value={when} max={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 20 L tank, fitted at the workshop" />
        </Field>
      </div>
    </Dialog>
  );
}
