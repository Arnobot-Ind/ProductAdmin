'use client';

import type { HardwareRevisionDto, ProductDto, RobotRegisteredDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { OneTimeKey } from '@/components/domain/one-time-secret';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, ErrorState, InlineAlert, KeyValue, Mono, PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

type ProductDetail = ProductDto & { revisions: HardwareRevisionDto[] };

export default function RegisterRobotPage() {
  useDocumentTitle('Register robot');
  const can = useCan();
  const qc = useQueryClient();
  const [productId, setProductId] = useState('');
  const [revisionId, setRevisionId] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<RobotRegisteredDto | null>(null);

  const products = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<ProductDto[]>('/products'), staleTime: 300_000 });
  const product = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.get<ProductDetail>(`/products/${productId}`),
    enabled: !!productId,
  });
  const selected = products.data?.find((p) => p.id === productId);
  const nextId = selected ? `${selected.code}${String(selected.next_running_number).padStart(2, '0')}` : null;

  const register = useMutation({
    mutationFn: () =>
      api.post<RobotRegisteredDto>('/robots', {
        product_id: productId,
        hardware_revision_id: revisionId || undefined,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['robots'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!productId) return setFormError('Choose a product');
    setFormError(null);
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
    return (
      <>
        <PageHeader eyebrow="Robot registered" title={<span className="font-mono">{result.robot.robot_id}</span>} />
        <div className="grid max-w-3xl gap-6">
          <Card title="Identity">
            <KeyValue
              items={[
                { label: 'Robot ID (permanent)', value: <Mono>{result.robot.robot_id}</Mono> },
                { label: 'Serial number (auto-generated, permanent)', value: <Mono>{result.robot.serial_number}</Mono> },
                { label: 'Product', value: result.robot.product_name },
                { label: 'Hardware revision', value: result.robot.hardware_revision ?? 'Not set' },
                { label: 'Owner', value: result.robot.owner_company ?? 'Arnobot' },
              ]}
            />
          </Card>
          <Card title="Ingest key for this robot">
            <OneTimeKey value={result.ingest_key}>
              <p className="text-sm text-muted">
                The robot (or the GCS relaying for it) sends <Mono>Authorization: Bearer &lt;key&gt;</Mono> to the ingest endpoint
                <Mono>POST /api/v1/ingest</Mono>. Messages must carry <Mono>&quot;robot_id&quot;: &quot;{result.robot.robot_id}&quot;</Mono> and
                <Mono>&quot;product&quot;: &quot;{result.robot.product_code}&quot;</Mono>. The same key uploads camera video to{' '}
                <Mono>PUT /api/v1/archive/upload</Mono> under <Mono>{result.robot.robot_id}/sessions/…</Mono>.
              </p>
            </OneTimeKey>
          </Card>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/robots/${result.robot.robot_id}`} variant="primary">
              Open robot
            </LinkButton>
            <Button
              onClick={() => {
                setResult(null);
                setNotes('');
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
        description="The PMS assigns both identifiers, and neither ever changes: the Robot ID (product code + running number, e.g. saibya02, ductcleaning01) and a unique 8-digit serial number."
      />
      {products.error ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : (
        <form onSubmit={submit} className="grid max-w-2xl gap-5 rounded-lg border border-border bg-surface p-5" noValidate>
          <Field label="Product" required>
            <Select
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setRevisionId('');
              }}
            >
              <option value="">Choose a product…</option>
              {products.data?.filter((p) => !p.deleted_at).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Hardware revision" hint="Optional in v1. A revision names one set of main components.">
            <Select value={revisionId} onChange={(e) => setRevisionId(e.target.value)} disabled={!productId}>
              <option value="">Not set</option>
              {product.data?.revisions.filter((r) => !r.deleted_at).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Serial number" hint="Generated automatically when you register: 8 unique digits.">
            <Input value="Auto-generated (8 digits)" readOnly disabled />
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
          {nextId && (
            <p className="text-sm text-muted" aria-live="polite">
              This robot will be assigned the next free ID for {selected?.name}, likely <Mono>{nextId}</Mono>.
            </p>
          )}
          {formError && (
            <p role="alert" className="text-sm font-medium text-fault">
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
