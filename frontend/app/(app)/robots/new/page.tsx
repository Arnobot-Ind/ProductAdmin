'use client';

import type { AttachmentDetailDto, AttachmentDto, HardwareRevisionDto, ProductDto, RobotAttachmentRefDto, RobotCategory, RobotRegisteredDto } from '@arnobot/message-schema';
import { CategoryPicker } from '@/components/domain/category-picker';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Puzzle } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { OneTimeKey } from '@/components/domain/one-time-secret';
import { CategoryIcon, RobotBuild, Thumb } from '@/components/domain/robot-build';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, ErrorState, InlineAlert, KeyValue, Mono, PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDocumentTitle } from '@/lib/hooks';
import { useCompanies } from '@/lib/queries';

type ProductDetail = ProductDto & { revisions: HardwareRevisionDto[] };
/** One attachment ticked for this robot: which revision and which unit. */
interface Fitting {
  revision: string;
  serial: string;
}

export default function RegisterRobotPage() {
  useDocumentTitle('Register robot');
  const can = useCan();
  const qc = useQueryClient();
  const [category, setCategory] = useState<RobotCategory | ''>('');
  const [productId, setProductId] = useState('');
  const [revisionId, setRevisionId] = useState('');
  const [notes, setNotes] = useState('');
  const [nickname, setNickname] = useState('');
  const [description, setDescription] = useState('');
  /** null = not chosen yet; 'none' = registered without an attachment; 'some' = the ticked ones in `fit`. */
  const [attachChoice, setAttachChoice] = useState<'none' | 'some' | null>(null);
  const [fit, setFit] = useState<Map<string, Fitting>>(new Map());
  /** '' = Arnobot (the default owner). */
  const [ownerId, setOwnerId] = useState('');
  const [tried, setTried] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<RobotRegisteredDto | null>(null);

  const products = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<ProductDto[]>('/products'), staleTime: 300_000 });
  const attachments = useQuery({ queryKey: ['attachments'], queryFn: () => api.get<AttachmentDto[]>('/attachments'), staleTime: 300_000 });
  const product = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.get<ProductDetail>(`/products/${productId}`),
    enabled: !!productId,
  });
  // Revisions of each ticked attachment.
  const fitIds = [...fit.keys()];
  const details = useQueries({
    queries: fitIds.map((id) => ({ queryKey: ['attachment', id], queryFn: () => api.get<AttachmentDetailDto>(`/attachments/${id}`), staleTime: 300_000 })),
  });
  const detailOf = (id: string) => details[fitIds.indexOf(id)]?.data;

  const selected = products.data?.find((p) => p.id === productId);
  const categoryProducts = (products.data ?? []).filter((p) => !p.deleted_at && p.category === category);
  const categoryAttachments = (attachments.data ?? []).filter((a) => !a.category || a.category === category);
  // Customers can be chosen only with ownership.write (the API checks it too); Arnobot is always allowed.
  const canAssign = can('ownership.write');
  const companies = useCompanies();
  const internal = companies.data?.find((c) => c.kind === 'internal');
  const customers = (companies.data ?? []).filter((c) => c.kind !== 'internal').sort((a, b) => a.name.localeCompare(b.name));
  const nextId = selected ? `${selected.code}${String(selected.next_running_number).padStart(2, '0')}` : null;

  const errors = {
    category: !category ? 'Choose UGV or UAV' : null,
    product: category && !productId ? 'Choose the base model this robot is built on' : null,
    attachments: category && !attachChoice ? 'Choose the attachments fitted on this robot, or “No attachment”' : null,
  };
  const shown = (e: string | null) => (tried ? e : null);

  const toggle = (id: string, on: boolean) => {
    const next = new Map(fit);
    if (on) next.set(id, { revision: '', serial: '' });
    else next.delete(id);
    setFit(next);
    setAttachChoice(next.size ? 'some' : null);
  };
  const setFitting = (id: string, patch: Partial<Fitting>) => setFit(new Map(fit).set(id, { ...fit.get(id)!, ...patch }));
  const reset = (c: RobotCategory | '') => {
    setCategory(c);
    setProductId('');
    setRevisionId('');
    setFit(new Map());
    setAttachChoice(null);
  };

  /** What the robot will be, as the robot page shows it. */
  const preview: RobotAttachmentRefDto[] = fitIds.map((id) => {
    const a = attachments.data?.find((x) => x.id === id);
    const f = fit.get(id)!;
    return {
      id,
      name: a?.name ?? '…',
      model_number: a?.model_number ?? null,
      cover_photo_id: a?.cover_photo_id ?? null,
      revision_name: detailOf(id)?.revisions.find((r) => r.id === f.revision)?.name ?? null,
      serial_number: f.serial.trim() || null,
    };
  });

  const register = useMutation({
    mutationFn: () =>
      api.post<RobotRegisteredDto>('/robots', {
        product_id: productId,
        hardware_revision_id: revisionId || undefined,
        notes: notes.trim() || undefined,
        nickname: nickname.trim() || undefined,
        description: description.trim() || undefined,
        attachments: attachChoice === 'some' ? fitIds.map((id) => ({ attachment_id: id, hardware_revision_id: fit.get(id)!.revision || null, serial_number: fit.get(id)!.serial.trim() || null })) : [],
        company_id: ownerId || undefined,
      }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['robots'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['attachments'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setFormError(null);
    // Each step shows its own message; take the person to the first one that still needs a choice.
    if (errors.category || errors.product || errors.attachments) {
      requestAnimationFrame(() => document.querySelector('fieldset[aria-invalid="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      return;
    }
    register.mutate();
  };

  if (!can('robot.write')) {
    return (
      <>
        <PageHeader title="Register robot" />
        <InlineAlert tone="fault">You don&apos;t have permission to register robots.</InlineAlert>
      </>
    );
  }

  if (result) {
    const r = result.robot;
    return (
      <>
        <PageHeader eyebrow="Robot registered" title={<span className="font-mono">{r.robot_id}</span>} />
        <div className="grid gap-6">
          <Card title="Identity">
            <RobotBuild
              className="mb-5"
              category={r.category}
              product={{ name: r.product_name, revision: r.hardware_revision, coverPhotoId: r.product_cover_photo_id }}
              attachments={r.attachments}
            />
            <KeyValue
              items={[
                { label: 'Robot ID (permanent)', value: <Mono>{r.robot_id}</Mono> },
                { label: 'Serial number (auto-generated, permanent)', value: <Mono>{r.serial_number}</Mono> },
                { label: 'Nickname', value: r.nickname ?? '—' },
                { label: 'Owner', value: r.owner_company ?? 'Arnobot' },
              ]}
            />
          </Card>
          <Card title="Ingest key for this robot">
            <OneTimeKey value={result.ingest_key}>
              <p className="text-sm text-muted">
                The robot (or the GCS relaying for it) sends <Mono>Authorization: Bearer &lt;key&gt;</Mono> to the ingest endpoint
                <Mono>POST /api/v1/ingest</Mono>. Messages must carry <Mono>&quot;robot_id&quot;: &quot;{r.robot_id}&quot;</Mono> and
                <Mono>&quot;product&quot;: &quot;{r.product_code}&quot;</Mono>. The same key uploads camera video to{' '}
                <Mono>PUT /api/v1/archive/upload</Mono> under <Mono>{r.robot_id}/sessions/…</Mono>.
              </p>
            </OneTimeKey>
          </Card>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/robots/${r.robot_id}`} variant="primary">
              Open robot
            </LinkButton>
            <Button
              onClick={() => {
                setResult(null);
                setNotes('');
                setOwnerId('');
                reset('');
                setNickname('');
                setDescription('');
                setTried(false);
              }}
            >
              Register another
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Robots"
        title="Register robot"
        description="The PMS assigns both identifiers, and neither ever changes: the Robot ID (base model code + running number, e.g. saibya02, ductcleaning01) and a unique 8-digit serial number."
      />
      {products.error ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : (
        <form onSubmit={submit} className="grid gap-6 rounded-lg border border-border bg-surface p-5" noValidate>
          <Step n={1} title="Category" required error={shown(errors.category)}>
            <CategoryPicker value={category} onChange={reset} />
          </Step>

          <Step n={2} title="Base model" required hint="The vehicle this robot is built on. Its code starts the Robot ID." error={shown(errors.product)} disabled={!category}>
            {!category ? (
              <p className="text-base text-muted">Choose the category first.</p>
            ) : categoryProducts.length === 0 ? (
              <p className="text-base text-muted">No {category.toUpperCase()} base models yet. Add one under Base models &amp; attachments.</p>
            ) : (
              <div role="radiogroup" aria-label="Base model" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {categoryProducts.map((p) => (
                  <Choice
                    key={p.id}
                    type="radio"
                    name="product"
                    checked={productId === p.id}
                    onChange={() => {
                      setProductId(p.id);
                      setRevisionId('');
                    }}
                    thumb={<Thumb photoId={p.cover_photo_id} icon={<CategoryIcon category={p.category} className="size-6" />} className="size-14" />}
                    title={p.name}
                    lines={[p.description ?? 'No description', `${p.robot_count} robot${p.robot_count === 1 ? '' : 's'} · next: ${p.code}${String(p.next_running_number).padStart(2, '0')}`]}
                  />
                ))}
              </div>
            )}
            {productId && (
              <Field label="Hardware revision of the base model" hint="Optional. A revision names one set of main components." className="mt-4 max-w-md">
                <Select value={revisionId} onChange={(e) => setRevisionId(e.target.value)}>
                  <option value="">Not set</option>
                  {product.data?.revisions.filter((r) => !r.deleted_at).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.description ? ` · ${r.description}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </Step>

          <Step
            n={3}
            title="Attachments"
            required
            hint="Tick every attachment fitted on this robot, or choose “No attachment”. You can fit or remove attachments later on the robot's page."
            error={shown(errors.attachments)}
            disabled={!category}
          >
            {!category ? (
              <p className="text-base text-muted">Choose the category first.</p>
            ) : (
              <>
                <div role="group" aria-label="Attachments" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Choice
                    type="radio"
                    name="no-attachment"
                    checked={attachChoice === 'none'}
                    onChange={() => {
                      setFit(new Map());
                      setAttachChoice('none');
                    }}
                    thumb={
                      <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted" aria-hidden>
                        <Ban className="size-6" />
                      </span>
                    }
                    title="No attachment"
                    lines={['Nothing fitted: just the base model']}
                  />
                  {categoryAttachments.map((a) => (
                    <Choice
                      key={a.id}
                      type="checkbox"
                      name="attachment"
                      checked={fit.has(a.id)}
                      onChange={(on) => toggle(a.id, on)}
                      thumb={<Thumb photoId={a.cover_photo_id} icon={<Puzzle className="size-6" />} className="size-14" />}
                      title={a.name}
                      lines={[[a.model_number, a.manufacturer].filter(Boolean).join(' · ') || null, a.description].filter((x): x is string => !!x)}
                    />
                  ))}
                </div>
                {categoryAttachments.length === 0 && (
                  <p className="mt-2 text-sm text-muted">No {category.toUpperCase()} attachments defined yet. Add them under Base models &amp; attachments.</p>
                )}
                {fitIds.length > 0 && (
                  <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
                    {fitIds.map((id) => {
                      const a = attachments.data?.find((x) => x.id === id);
                      const revs = detailOf(id)?.revisions.filter((r) => !r.deleted_at) ?? [];
                      return (
                        <li key={id} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,12rem)_1fr_1fr] sm:items-end">
                          <p className="self-center font-semibold">{a?.name}</p>
                          <Field label="Revision">
                            <Select value={fit.get(id)!.revision} onChange={(e) => setFitting(id, { revision: e.target.value })} disabled={!revs.length}>
                              <option value="">{revs.length ? 'Not recorded' : 'No revisions defined'}</option>
                              {revs.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Serial number of this unit">
                            <Input value={fit.get(id)!.serial} onChange={(e) => setFitting(id, { serial: e.target.value })} maxLength={100} placeholder="Optional" spellCheck={false} />
                          </Field>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </Step>

          <Step n={4} title="Name and owner">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nickname" hint="Optional. Shown next to the Robot ID everywhere, e.g. Khavda patrol 1.">
                <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={60} />
              </Field>
              <Field
                label="Owner"
                hint={canAssign ? 'Who the robot belongs to from today. You can transfer it later.' : 'Registered robots start with Arnobot. Assigning a customer needs the ownership permission.'}
              >
                <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={!canAssign || companies.isLoading}>
                  <option value="">{internal?.name ?? 'Arnobot'} (Arnobot)</option>
                  {canAssign && customers.length > 0 && (
                    <optgroup label="Customers">
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </Field>
              <Field label="Short description" hint="Optional. One or two lines: what it does and where." className="sm:col-span-2">
                <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
              </Field>
              <Field label="Notes" hint="Internal notes (not shown on lists)." className="sm:col-span-2">
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
              </Field>
            </div>
          </Step>

          {selected && (
            <section aria-labelledby="reg-preview" className="rounded-xl bg-surface-2 p-4">
              <h2 id="reg-preview" className="mb-3 text-lg font-semibold">
                Will be registered as <span className="font-mono">{nextId}</span>
                {nickname.trim() && ` · ${nickname.trim()}`}
                <span className="block text-sm font-normal text-muted">The serial number is generated when you register (8 digits). The ID is the next free one, most likely this.</span>
              </h2>
              <RobotBuild
                category={selected.category}
                product={{ name: selected.name, revision: product.data?.revisions.find((r) => r.id === revisionId)?.name ?? null, coverPhotoId: selected.cover_photo_id }}
                attachments={attachChoice === 'some' ? preview : []}
              />
              {!attachChoice && <p className="mt-2 text-sm font-medium text-warn">Attachments not chosen yet.</p>}
            </section>
          )}

          {formError && (
            <p role="alert" className="text-base font-medium text-fault">
              {formError}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={register.isPending}>
              Register robot
            </Button>
            <LinkButton href="/robots">Cancel</LinkButton>
          </div>
        </form>
      )}
    </>
  );
}

/** A numbered part of the form; `required` groups show their error under the title. */
function Step({ n, title, required, hint, error, disabled, children }: { n: number; title: string; required?: boolean; hint?: string; error?: string | null; disabled?: boolean; children: ReactNode }) {
  return (
    <fieldset className={cn('min-w-0', disabled && 'opacity-60')} aria-invalid={error ? true : undefined}>
      <legend className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <span className="flex size-7 items-center justify-center rounded-full bg-accent text-sm text-white" aria-hidden>
          {n}
        </span>
        {title}
        {required && (
          <span className="text-fault" aria-hidden="true">
            *
          </span>
        )}
      </legend>
      {hint && <p className="-mt-1 mb-3 text-sm text-muted">{hint}</p>}
      {children}
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-fault">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** A selectable card with a picture: a radio (one of) or a checkbox (any of). */
function Choice({
  type,
  name,
  checked,
  onChange,
  thumb,
  title,
  lines,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  thumb: ReactNode;
  title: string;
  lines: string[];
}) {
  return (
    <label
      className={cn(
        'relative flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border-2 p-2.5 pr-8 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent/50',
      )}
    >
      <input type={type} name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
      {thumb}
      <span className="min-w-0">
        <span className="block text-base font-semibold break-words">{title}</span>
        {lines.map((l) => (
          <span key={l} className="line-clamp-2 text-sm break-words text-muted" title={l}>
            {l}
          </span>
        ))}
      </span>
      {checked && <CheckCircle2 className="absolute top-2 right-2 size-5 text-accent-text" aria-hidden />}
    </label>
  );
}
