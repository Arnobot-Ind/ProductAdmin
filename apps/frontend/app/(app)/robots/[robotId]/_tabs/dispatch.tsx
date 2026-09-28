'use client';

import type { DispatchWarrantyDto, DocumentDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { WarrantyBadge } from '@/components/domain/status';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, KeyValue, QueryView, Time } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, downloadUrl } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDate } from '@/lib/format';

/** Spec §3 row 8: dispatch date, warranty start/end, warranty clauses (file). */
export function DispatchTab({ robotId }: { robotId: string }) {
  const q = useQuery({ queryKey: ['robot', robotId, 'dispatch'], queryFn: () => api.get<DispatchWarrantyDto>(`/robots/${robotId}/dispatch`) });
  return <QueryView query={q}>{(d) => <DispatchView d={d} robotId={robotId} />}</QueryView>;
}

function DispatchView({ d, robotId }: { d: DispatchWarrantyDto; robotId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ dispatch_date: '', warranty_start: '', warranty_end: '', warranty_document_id: '', notes: '' });
  useEffect(() => {
    setForm({
      dispatch_date: d.dispatch_date ?? '',
      warranty_start: d.warranty_start ?? '',
      warranty_end: d.warranty_end ?? '',
      warranty_document_id: d.warranty_document_id ?? '',
      notes: d.notes ?? '',
    });
  }, [d]);

  // Warranty clauses are uploaded as a "warranty_clauses" document (Documents tab), then linked here.
  const docs = useQuery({ queryKey: ['robot', robotId, 'documents'], queryFn: () => api.get<DocumentDto[]>(`/robots/${robotId}/documents`), enabled: can('robot.write') });
  const warrantyDocs = (docs.data ?? []).filter((x) => x.doc_type === 'warranty_clauses' && !x.deleted_at);

  const save = useMutation({
    mutationFn: () =>
      api.put<DispatchWarrantyDto>(`/robots/${robotId}/dispatch`, {
        dispatch_date: form.dispatch_date || null,
        warranty_start: form.warranty_start || null,
        warranty_end: form.warranty_end || null,
        warranty_document_id: form.warranty_document_id || null,
        notes: form.notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Dispatch & warranty saved');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'dispatch'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: toast.error,
  });
  const rangeError = form.warranty_start && form.warranty_end && form.warranty_end < form.warranty_start ? 'Warranty end must be on or after the start' : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!rangeError) save.mutate();
  };

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="Current" actions={<WarrantyBadge status={d.warranty_status} />}>
        <KeyValue
          items={[
            { label: 'Dispatch date', value: fmtDate(d.dispatch_date) },
            { label: 'Warranty start', value: fmtDate(d.warranty_start) },
            { label: 'Warranty end', value: fmtDate(d.warranty_end) },
            {
              label: 'Warranty clauses',
              value: d.warranty_document?.latest ? (
                <a href={downloadUrl(`/document-versions/${d.warranty_document.latest.id}/download`)} className="inline-flex items-center gap-1 text-accent-text hover:underline">
                  <Download className="size-4" aria-hidden /> {d.warranty_document.title} (v{d.warranty_document.latest.version_no})
                </a>
              ) : null,
            },
            { label: 'Notes', value: d.notes },
            { label: 'Last changed', value: <Time iso={d.updated_at} /> },
          ]}
        />
      </Card>
      {can('robot.write') && (
        <Card title="Edit">
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Dispatch date">
              <Input type="date" value={form.dispatch_date} onChange={(e) => setForm({ ...form, dispatch_date: e.target.value })} />
            </Field>
            <span className="hidden sm:block" />
            <Field label="Warranty start">
              <Input type="date" value={form.warranty_start} onChange={(e) => setForm({ ...form, warranty_start: e.target.value })} />
            </Field>
            <Field label="Warranty end" error={rangeError}>
              <Input type="date" value={form.warranty_end} min={form.warranty_start || undefined} onChange={(e) => setForm({ ...form, warranty_end: e.target.value })} />
            </Field>
            <Field label="Warranty clauses document" className="sm:col-span-2" hint="Upload the file as type “Warranty clauses” in the Documents tab, then link it here.">
              <Select value={form.warranty_document_id} onChange={(e) => setForm({ ...form, warranty_document_id: e.target.value })}>
                <option value="">None</option>
                {warrantyDocs.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title} ({x.source_label})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!!rangeError}>
                Save
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
