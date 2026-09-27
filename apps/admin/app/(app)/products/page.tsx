'use client';

import type { ProductDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, Mono, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

export default function ProductsPage() {
  useDocumentTitle('Products');
  const can = useCan();
  const router = useRouter();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['products', { includeDeleted }], queryFn: () => api.get<ProductDto[]>('/products', { include_deleted: includeDeleted }) });

  return (
    <>
      <PageHeader
        eyebrow="Catalogue"
        title="Products"
        description="Products are defined once; every robot points to one product. New products are added as data, with no code change. The product code prefixes every Robot ID and is permanent."
        actions={
          can('catalog.write') ? (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
              Add product
            </Button>
          ) : undefined
        }
      />
      <div className="mb-3">
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
      </div>
      <QueryView query={q}>
        {(products) =>
          products.length === 0 ? (
            <EmptyState title="No products" />
          ) : (
            <DataTable
              caption="Products"
              rows={products}
              rowKey={(p) => p.id}
              onRowClick={(p) => router.push(`/products/${p.id}`)}
              rowClassName={(p) => (p.deleted_at ? 'opacity-60' : undefined)}
              columns={[
                {
                  key: 'name',
                  header: 'Product',
                  rowHeader: true,
                  cell: (p) => (
                    <Link href={`/products/${p.id}`} className="font-semibold text-accent-text hover:underline" onClick={(e) => e.stopPropagation()}>
                      {p.name}
                    </Link>
                  ),
                },
                { key: 'code', header: 'Code', cell: (p) => <Mono>{p.code}</Mono> },
                { key: 'desc', header: 'Description', cell: (p) => p.description ?? '—' },
                { key: 'robots', header: 'Robots', align: 'right', cell: (p) => p.robot_count },
                { key: 'revs', header: 'Revisions', align: 'right', cell: (p) => p.revision_count },
                { key: 'next', header: 'Next Robot ID', cell: (p) => <Mono>{`${p.code}${String(p.next_running_number).padStart(2, '0')}`}</Mono> },
                { key: 'state', header: 'State', cell: (p) => (p.deleted_at ? <Badge tone="fault">Deleted</Badge> : <Badge tone="ok">Active</Badge>) },
              ]}
            />
          )
        }
      </QueryView>
      <AddProductDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddProductDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [description, setDescription] = useState('');
  const derived = name.trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  const effectiveCode = codeTouched ? code : derived;
  const codeValid = /^[a-z][a-z_]*$/.test(effectiveCode);
  const m = useMutation({
    mutationFn: () => api.post<ProductDto>('/products', { code: effectiveCode, name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (p) => {
      toast.success(`Product ${p.name} added`);
      void qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
      router.push(`/products/${p.id}`);
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add product"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim() || !codeValid}>
            Add product
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field
          label="Code"
          required
          hint={`Lower-case letters and underscores. Robot IDs will look like ${effectiveCode || 'code'}01. It can never be changed.`}
          error={effectiveCode && !codeValid ? 'Use lower-case letters and underscores only, starting with a letter' : null}
        >
          <Input
            value={effectiveCode}
            onChange={(e) => {
              setCodeTouched(true);
              setCode(e.target.value);
            }}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
