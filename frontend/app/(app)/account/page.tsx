'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, KeyValue, PageHeader } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

const MIN_PASSWORD = 10;

export default function AccountPage() {
  useDocumentTitle('My account');
  const me = useMe();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) return setError(`The new password must be at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setError('The new passwords do not match.');
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const active = (me.grants ?? []).filter((g) => !g.revoked_at);

  return (
    <>
      <PageHeader eyebrow="Platform" title="My account" description="See Roles & permissions for what each permission allows." />
      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <Card title="Profile">
          <KeyValue
            columns={1}
            items={[
              { label: 'Name', value: me.name },
              { label: 'Email', value: me.email },
              { label: 'Organization', value: me.organization ? `${me.organization.name}${me.organization.kind === 'internal' ? ' (Arnobot staff)' : ''}` : '—' },
              {
                label: 'Roles',
                value: active.length ? (
                  <ul className="flex flex-col gap-1">
                    {active.map((g) => (
                      <li key={g.id} className="flex items-center gap-2 text-sm">
                        <Badge tone="accent">{g.role_name}</Badge>
                        {g.scope_type === 'platform' ? 'All of Arnobot' : g.scope_type === 'company' ? (me.organization?.name ?? g.scope_id) : `${g.scope_type}: ${g.scope_id}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None'
                ),
              },
              {
                label: 'What you can do',
                value: (
                  <span className="flex flex-wrap gap-1">
                    {(me.scoped_permissions ?? me.permissions ?? []).map((p) => (
                      <code key={p} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                        {p}
                      </code>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        </Card>
        <Card title="Change password">
          <form onSubmit={submit} className="grid gap-4" noValidate>
            <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
            <Field label="Current password" required>
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" required hint={`At least ${MIN_PASSWORD} characters. A long passphrase is best.`}>
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label="Confirm new password" required>
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {error && (
              <p role="alert" className="text-sm font-medium text-fault">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" variant="primary" loading={busy} disabled={!current || !next || !confirm}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
