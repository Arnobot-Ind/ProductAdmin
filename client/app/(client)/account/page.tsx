'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, InlineAlert, KeyValue, PageHeader } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

const MIN_PASSWORD = 10;

/** The client's own account: who they are, their role, and changing their password. */
export default function PortalAccountPage() {
  useDocumentTitle('Account');
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

  const roles = [...new Set((me.grants ?? []).filter((g) => !g.revoked_at).map((g) => g.role_name))];

  return (
    <>
      <PageHeader title="Account" />
      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <Card title="Profile">
          <KeyValue
            columns={1}
            items={[
              { label: 'Name', value: me.name },
              { label: 'Email', value: me.email },
              { label: 'Organization', value: me.organization.name },
              {
                label: 'Role',
                value: roles.length ? (
                  <span className="flex flex-wrap gap-1">
                    {roles.map((r) => (
                      <Badge key={r} tone="accent">
                        {r}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  'None'
                ),
              },
            ]}
          />
        </Card>
        <Card title="Change password">
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field label="Current password" required>
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </Field>
            <Field label="New password" required hint={`At least ${MIN_PASSWORD} characters.`}>
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </Field>
            <Field label="Repeat new password" required>
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>
            {error && <InlineAlert tone="fault">{error}</InlineAlert>}
            <div>
              <Button type="submit" variant="primary" loading={busy}>
                Change password
              </Button>
            </div>
            <p className="text-xs text-muted">Changing your password signs you out on every other device.</p>
          </form>
        </Card>
      </div>
    </>
  );
}
