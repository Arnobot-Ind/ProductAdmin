'use client';

import { Building2, Check, Eye, EyeOff, KeyRound, LogOut, Mail, ShieldCheck, UserRound, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, InlineAlert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useMe, useSignOut } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDocumentTitle } from '@/lib/hooks';
import { BesideBack } from '@/components/ui/back-button';

const MIN_PASSWORD = 10;

/** "Harshil Shah" → "HS"; falls back to the email. */
function initials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? email).slice(0, 2)).toUpperCase();
}

/** The client's own account: who they are, their access, password and signing out. */
export default function PortalAccountPage() {
  useDocumentTitle('Account');
  const me = useMe();
  const { signOut, signingOut } = useSignOut();
  const roles = [...new Set((me.grants ?? []).filter((g) => !g.revoked_at).map((g) => g.role_name))];
  const features = me.client?.features.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Who is signed in */}
      <BesideBack>
        <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:p-6">
          <span className="inline-flex size-16 shrink-0 items-center justify-center rounded-full bg-accent text-xl font-semibold text-accent-fg" aria-hidden>
            {initials(me.name, me.email)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold">{me.name}</h1>
            <p className="mt-0.5 truncate text-sm text-muted">{me.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {roles.map((r) => (
                <Badge key={r} tone="accent">
                  {r}
                </Badge>
              ))}
              <span className="text-sm text-muted">{me.organization.name}</span>
            </div>
          </div>
          <Button onClick={signOut} loading={signingOut} icon={<LogOut className="size-4" aria-hidden />} className="self-start sm:self-center">
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </section>
      </BesideBack>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Profile">
          <dl className="flex flex-col divide-y divide-border">
            <Detail icon={<UserRound className="size-4" />} label="Name" value={me.name} />
            <Detail icon={<Mail className="size-4" />} label="Email" value={me.email} />
            <Detail icon={<Building2 className="size-4" />} label="Organization" value={me.organization.name} />
            <Detail icon={<ShieldCheck className="size-4" />} label="Role" value={roles.join(', ') || 'None'} />
            {me.client && <Detail icon={<KeyRound className="size-4" />} label="Access" value={`${features} feature${features === 1 ? '' : 's'} enabled by your organization`} />}
          </dl>
          <p className="mt-4 text-xs text-muted">To change your name, email or access, ask your organization's Manager or Arnobot support.</p>
        </Card>
        <PasswordCard />
      </div>
    </div>
  );
}

function Detail({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 text-muted" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-sm font-medium text-muted">{label}</dt>
        <dd className="mt-0.5 break-words">{value}</dd>
      </div>
    </div>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const longEnough = next.length >= MIN_PASSWORD;
  const matches = !!next && next === confirm;
  const different = !!next && next !== current;
  const ready = !!current && longEnough && matches && different;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return setError(!longEnough ? `The new password must be at least ${MIN_PASSWORD} characters.` : !matches ? 'The new passwords do not match.' : 'Choose a password different from the current one.');
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });
      toast.success('Password changed. Other devices have been signed out.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const type = show ? 'text' : 'password';
  return (
    <Card
      title="Password"
      actions={
        <button type="button" onClick={() => setShow((v) => !v)} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg" aria-pressed={show}>
          {show ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          {show ? 'Hide passwords' : 'Show passwords'}
        </button>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field label="Current password" required>
          <Input type={type} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" required>
            <Input type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Repeat new password" required>
            <Input type={type} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        <ul className="flex flex-col gap-1 text-xs" aria-live="polite">
          <Rule ok={longEnough} pending={!next}>
            At least {MIN_PASSWORD} characters
          </Rule>
          <Rule ok={matches} pending={!confirm}>
            Both new passwords match
          </Rule>
          <Rule ok={different} pending={!next || !current}>
            Different from the current password
          </Rule>
        </ul>
        {error && <InlineAlert tone="fault">{error}</InlineAlert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            Change password
          </Button>
          <p className="text-xs text-muted">You stay signed in here; every other device is signed out.</p>
        </div>
      </form>
    </Card>
  );
}

function Rule({ ok, pending, children }: { ok: boolean; pending: boolean; children: ReactNode }) {
  return (
    <li className={cn('inline-flex items-center gap-1.5', pending ? 'text-muted' : ok ? 'text-ok' : 'text-fault')}>
      {pending || ok ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
      {children}
    </li>
  );
}
