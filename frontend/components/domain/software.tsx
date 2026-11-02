'use client';

import type { SoftwareKind, SoftwareProductDto } from '@arnobot/message-schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isCommitId } from '@/components/domain/source-link';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { SOFTWARE_KINDS } from '@/lib/schema';

export const KIND_LABELS: Record<SoftwareKind, string> = {
  desktop_app: 'Desktop app',
  web_app: 'Web app',
  robot_software: 'Robot software',
  firmware: 'Firmware',
  service: 'Service',
};

/** Add catalogue software, or edit one (name, kind, description, latest version, GitHub link, commit). */
export function ProductDialog({ product, onClose }: { product: SoftwareProductDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    code: product?.code ?? '',
    name: product?.name ?? '',
    kind: product?.kind ?? ('desktop_app' as SoftwareKind),
    description: product?.description ?? '',
    latest_version: product?.latest_version ?? '',
    repo_url: product?.repo_url ?? '',
    commit_id: product?.commit_id ?? '',
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        kind: f.kind,
        description: f.description.trim() || null,
        latest_version: f.latest_version.trim() || null,
        repo_url: f.repo_url.trim() || null,
        commit_id: f.commit_id.trim() || null,
      };
      return product ? api.patch<SoftwareProductDto>(`/software-products/${product.id}`, body) : api.post<SoftwareProductDto>('/software-products', { ...body, code: f.code.trim() });
    },
    onSuccess: (p) => {
      toast.success(product ? `${p.name} updated` : `${p.name} added`);
      void qc.invalidateQueries({ queryKey: ['software-products'] });
      void qc.invalidateQueries({ queryKey: ['software', p.id] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
    },
    onError: toast.error,
  });
  const codeBad = !product && !!f.code && !/^[a-z][a-z0-9_]*$/.test(f.code.trim());
  const repoBad = !!f.repo_url.trim() && !/^https?:\/\/\S+$/i.test(f.repo_url.trim());
  const commitBad = !!f.commit_id.trim() && !isCommitId(f.commit_id.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={product ? `Edit ${product.name}` : 'New software'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!f.name.trim() || (!product && !f.code.trim()) || codeBad || repoBad || commitBad}>
            {product ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} data-autofocus />
        </Field>
        <Field
          label="Code"
          required={!product}
          hint={product ? 'Codes never change.' : 'Lowercase letters, digits and _. Cannot be changed or reused later.'}
          error={codeBad ? 'Lowercase letters, digits and _, starting with a letter' : null}
        >
          <Input value={f.code} onChange={(e) => set({ code: e.target.value })} className="font-mono" disabled={!!product} placeholder="gcs_desktop" />
        </Field>
        <Field label="Kind" required>
          <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as SoftwareKind })}>
            {SOFTWARE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Latest version" hint="Installs on an older version show “update available”.">
          <Input value={f.latest_version} onChange={(e) => set({ latest_version: e.target.value })} className="font-mono" placeholder="1.0.0" />
        </Field>
        <Field label="GitHub link" hint="Optional: repository or release page of the latest version" error={repoBad ? 'A web link starting with https://' : null}>
          <Input value={f.repo_url} onChange={(e) => set({ repo_url: e.target.value })} placeholder="https://github.com/…" spellCheck={false} />
        </Field>
        <Field label="Commit ID" hint="Optional, of the latest version" error={commitBad ? '7–64 letters a–f and digits' : null}>
          <Input value={f.commit_id} onChange={(e) => set({ commit_id: e.target.value })} className="font-mono" spellCheck={false} placeholder="3f9c2ab" />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  );
}
