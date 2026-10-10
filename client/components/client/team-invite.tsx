'use client';

import type { UserCredentialsDto } from '@arnobot/message-schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { CopyButton, InlineAlert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

const fmtExpiry = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST' : 'in 72 hours';

/** The message a Manager pastes into their own email / chat to a colleague. */
export function inviteMessage(r: UserCredentialsDto): string {
  return [
    `Hello ${r.user.name},`,
    '',
    `You've been invited to the Arnobot portal for ${r.user.company_name}, where you can see your robots, their day-wise reports and distance by day.`,
    '',
    'Open this link to choose your password and sign in (it works once and expires in 72 h):',
    r.invite_url ?? '',
    '',
    'After that, sign in at the same address with your email and password.',
  ].join('\n');
}

/** One-time invitation link, shown once after an invite or a new link. */
export function InviteLinkDialog({ result, onClose }: { result: UserCredentialsDto | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!result}
      onClose={onClose}
      title="Invitation link ready"
      description={result ? `${result.user.name} · ${result.user.email}` : undefined}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {result?.invite_url && (
        <div className="flex flex-col gap-3">
          <InlineAlert tone="warn" title="Copy it now: it is shown only once">
            Send it to {result.user.name} yourself, for example from your company email. It works once and expires {fmtExpiry(result.invite_expires_at)}. They choose their own password.
          </InlineAlert>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-3">
            <Link2 className="size-4 text-muted" aria-hidden />
            <code className="min-w-0 flex-1 font-mono text-sm break-all select-all">{result.invite_url}</code>
            <CopyButton value={result.invite_url} label="Copy link" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Ready-to-send message</p>
              <CopyButton value={inviteMessage(result)} label="Copy message" />
            </div>
            <pre className="rounded-md border border-border bg-surface-2 p-3 text-xs whitespace-pre-wrap">{inviteMessage(result)}</pre>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Invite a colleague into the Manager's own organization (the API fixes the organization). */
export function InviteDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (r: UserCredentialsDto) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const blank = { name: '', email: '', role: 'viewer' as 'viewer' | 'manager' };
  const [f, setF] = useState(blank);
  const m = useMutation({
    mutationFn: () =>
      api.post<UserCredentialsDto>('/users', { name: f.name.trim(), email: f.email.trim(), credentials: 'invite', role_key: f.role, scope_type: 'company' }),
    onSuccess: (r) => {
      toast.success('Invitation created');
      void qc.invalidateQueries({ queryKey: ['portal', 'team'] });
      setF(blank);
      onClose();
      onInvited(r);
    },
    onError: toast.error,
  });
  const valid = f.name.trim() && /\S+@\S+\.\S+/.test(f.email);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite a colleague"
      description="They get a one-time link to choose their own password."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>
            Create invitation
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) m.mutate();
        }}
      >
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Email" required>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Role" className="sm:col-span-2" hint={f.role === 'manager' ? 'Sees the robots and reports, and can invite and remove colleagues.' : 'Sees the robots and downloads reports.'}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as typeof f.role })}>
            <option value="viewer">Viewer</option>
            <option value="manager">Manager</option>
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
