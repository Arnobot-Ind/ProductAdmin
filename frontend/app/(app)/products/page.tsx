'use client';

import type { ProductDto, RobotCategory } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Image as ImageIcon, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, Mono, PageHeader, QueryView } from '@/components/ui/misc';
import { CategoryPicker } from '@/components/domain/category-picker';
import { CategoryAttachments } from '@/components/domain/attachments-catalog';
import { mediaUrl } from '@/components/domain/product-media';
import { CategoryBadge } from '@/components/domain/status';
import { cn } from '@/lib/cn';
import { ROBOT_CATEGORIES, ROBOT_CATEGORY_LABEL } from '@/lib/schema';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

export default function ProductsPage() {
  useDocumentTitle('Base models');
  const can = useCan();
  const router = useRouter();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['products', { includeDeleted }], queryFn: () => api.get<ProductDto[]>('/products', { include_deleted: includeDeleted }) });

  return (
    <>
      <PageHeader
        eyebrow="Hardware & software"
        title="Base models & attachments"
        description="Two categories, UGV (ground) and UAV (aerial). Each has base models (the vehicle every robot is built on) and attachments (equipment fitted on a vehicle). The base model code prefixes every Robot ID and is permanent."
        actions={
          can('catalog.write') ? (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
              Add base model
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
            <EmptyState title="No base models" />
          ) : (
            <div className="flex flex-col gap-8">
              {ROBOT_CATEGORIES.map((cat) => {
                const list = products.filter((p) => p.category === cat);
                return (
                  <section key={cat} aria-labelledby={`cat-${cat}`}>
                    <h2 id={`cat-${cat}`} className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold">
                      <CategoryBadge category={cat} /> {cat === 'uav' ? 'Aerial robots' : 'Ground robots'}
                      <span className="text-base font-normal text-muted">
                        · {list.length} base model{list.length === 1 ? '' : 's'}, {list.reduce((n, p) => n + p.robot_count, 0)} robots
                      </span>
                    </h2>
                    <div className="flex flex-col gap-5 rounded-2xl border border-border bg-surface/60 p-4 sm:p-5">
                      <div>
                        <h3 className="mb-2 flex items-center gap-2 text-lg font-semibold">
                          <Boxes className="size-5 text-accent-text" aria-hidden /> Base models <span className="text-base font-normal text-muted">· {list.length}</span>
                        </h3>
                        {list.length === 0 ? (
                          <p className="rounded-xl border border-dashed border-border p-4 text-base text-muted">No {ROBOT_CATEGORY_LABEL[cat]} base models yet.</p>
                        ) : (
                          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {list.map((p) => (
                              <li key={p.id} className="min-w-0">
                                <ProductTile p={p} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <CategoryAttachments category={cat} includeDeleted={includeDeleted} />
                    </div>
                  </section>
                );
              })}
            </div>
          )
        }
      </QueryView>
      <AddProductDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function ProductTile({ p }: { p: ProductDto }) {
  return (
    <Link
      href={`/products/${p.id}`}
      className={cn('group flex h-full gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md', p.deleted_at && 'opacity-60')}
    >
      <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 sm:size-24">
        {p.cover_photo_id ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
          <img src={mediaUrl(p.cover_photo_id)} alt="" className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-7 text-muted" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="truncate text-lg font-semibold text-accent-text group-hover:underline">{p.name}</span>
          {p.deleted_at && <Badge tone="fault">Deleted</Badge>}
        </span>
        <span className="block truncate text-sm text-muted">{p.description ?? 'No description'}</span>
        <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span>
            <span className="font-semibold tabular-nums">{p.robot_count}</span> robot{p.robot_count === 1 ? '' : 's'}
          </span>
          <span>
            <span className="font-semibold tabular-nums">{p.revision_count}</span> revision{p.revision_count === 1 ? '' : 's'}
          </span>
          <span className="break-all text-muted">
            Next ID <Mono>{`${p.code}${String(p.next_running_number).padStart(2, '0')}`}</Mono>
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
          {p.photo_count > 0 && <Badge>{p.photo_count} photo{p.photo_count === 1 ? '' : 's'}</Badge>}
          {p.spin_count > 0 && <Badge>360° view</Badge>}
          {p.model_3d_id && <Badge>3D model</Badge>}
          {p.repo_url && <Badge>Repository</Badge>}
        </span>
      </span>
    </Link>
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
  const [category, setCategory] = useState<RobotCategory | ''>('');
  const derived = name.trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  const effectiveCode = codeTouched ? code : derived;
  const codeValid = /^[a-z][a-z_]*$/.test(effectiveCode);
  const m = useMutation({
    mutationFn: () => api.post<ProductDto>('/products', { code: effectiveCode, name: name.trim(), description: description.trim() || undefined, category }),
    onSuccess: (p) => {
      toast.success(`Base model ${p.name} added`);
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
      title="Add base model"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim() || !codeValid || !category}>
            Add base model
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Category" required>
          <CategoryPicker value={category} onChange={setCategory} />
        </Field>
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
