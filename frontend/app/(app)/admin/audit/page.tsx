'use client';

import type { AuditEntryDto, Paginated } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Download, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, PageHeader, Pagination, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api, downloadUrl, qs } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fromLocalInput } from '@/lib/format';
import { useDebounced, useDocumentTitle } from '@/lib/hooks';
import { useCompanies } from '@/lib/queries';

const ACTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All events' },
  { value: 'auth.', label: 'Sign-ins & passwords' },
  { value: 'data.', label: 'Data access (views, downloads, deletes)' },
  { value: 'data.downloaded', label: '· Downloads' },
  { value: 'data.viewed', label: '· Recordings opened' },
  { value: 'robot.assigned', label: 'Robot assignments' },
  { value: 'grant.', label: 'Permission changes' },
  { value: 'user.', label: 'User changes' },
  { value: 'org.', label: 'Organization changes' },
  { value: 'access.denied', label: 'Refused requests' },
  { value: 'credential.revealed', label: 'Device credential reveals' },
];

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'auth.invite_accepted': 'Accepted invitation',
  'access.denied': 'Request refused',
  'user.created': 'Created user',
  'user.invited': 'Invited user',
  'user.updated': 'Updated user',
  'user.deleted': 'Deleted user',
  'user.restored': 'Restored user',
  'grant.added': 'Granted role',
  'grant.revoked': 'Revoked role',
  'org.created': 'Created organization',
  'org.updated': 'Updated organization',
  'org.deleted': 'Deleted organization',
  'org.restored': 'Restored organization',
  'robot.assigned': 'Assigned robot',
  'data.viewed': 'Opened recording',
  'data.downloaded': 'Downloaded',
  'data.deleted': 'Deleted recording',
  'data.restored': 'Restored recording',
  'hardware.updated': 'Edited hardware part',
  'software.recorded': 'Recorded software update',
  'credential.revealed': 'Revealed device credential',
};

/** One readable line for an entry's details. */
function summary(e: AuditEntryDto): string {
  const d = e.detail as Record<string, unknown>;
  const s = (k: string) => (d[k] === undefined || d[k] === null ? '' : String(d[k]));
  switch (e.action) {
    case 'robot.assigned':
      return `${e.robot_id}: ${s('from_company') || '—'} → ${s('to_company')}${d.revoked_robot_grants ? ` · ${s('revoked_robot_grants')} robot role(s) revoked` : ''}${s('reason') ? ` · ${s('reason')}` : ''}`;
    case 'grant.added':
    case 'grant.revoked':
      return `${s('user_email')} · ${s('role')} @ ${d.scope_type === 'company' ? `organization ${e.company_name ?? s('scope_id')}` : `${s('scope_type')}${s('scope_id') ? ` ${s('scope_id')}` : ''}`}${s('reason') ? ` · ${s('reason')}` : ''}`;
    case 'data.downloaded':
      return `${s('file')}${d.restricted ? ' (restricted sensor data)' : ''}`;
    case 'data.viewed':
      return s('session_id');
    case 'access.denied':
      return `needs ${s('permission')} · ${s('method')} ${s('path')}`;
    case 'auth.login_failed':
      return s('reason');
    case 'hardware.updated':
      return `${s('part')}${d.slot ? ` ${s('slot')}` : ''}: ${Object.keys((d.changes as object) ?? {}).join(', ')}`;
    case 'software.recorded': {
      const to = (d.to ?? {}) as Record<string, unknown>;
      return `software ${to.sw_ver ?? '—'} · firmware ${to.fw_ver ?? '—'}${s('note') ? ` · ${s('note')}` : ''}`;
    }
    case 'user.created':
    case 'user.invited':
    case 'user.updated':
    case 'user.deleted':
    case 'user.restored':
      return [s('email'), s('organization'), s('credentials') || s('credentials_reissued'), d.is_active === false ? 'disabled' : d.is_active === true ? 'enabled' : '', d.password_reset ? 'password reset' : '']
        .filter(Boolean)
        .join(' · ');
    case 'org.created':
    case 'org.deleted':
    case 'org.restored':
      return s('name');
    default:
      return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}

export default function AuditPage() {
  useDocumentTitle('Audit log');
  const can = useCan();
  const companies = useCompanies(can('audit.read'));
  const [f, setF] = useState({ action: '', outcome: '', company_id: '', robot: '', q: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const text = useDebounced(f.q, 300);
  const robot = useDebounced(f.robot.trim().toLowerCase(), 300);
  const params = {
    action: f.action || undefined,
    outcome: f.outcome || undefined,
    company_id: f.company_id || undefined,
    robot: /^[a-z][a-z0-9_]*[0-9]+$/.test(robot) ? robot : undefined,
    q: text || undefined,
    from: fromLocalInput(f.from),
    to: fromLocalInput(f.to),
  };
  const q = useQuery({
    queryKey: ['audit', params, page],
    queryFn: () => api.get<Paginated<AuditEntryDto>>('/audit', { ...params, page, limit: 50 }),
    enabled: can('audit.read'),
    placeholderData: (prev) => prev,
  });
  const set = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    setPage(1);
  };

  if (!can('audit.read')) {
    return (
      <>
        <PageHeader title="Audit log" />
        <InlineAlert tone="fault">You don&apos;t have permission to read the audit log.</InlineAlert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Audit log"
        description="Who signed in, who opened or downloaded which robot's data, robot assignments, permission changes and refused requests. Entries cannot be edited or deleted."
        actions={
          <a
            href={downloadUrl(`/audit/export.csv${qs(params)}`)}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2"
          >
            <Download className="size-4" aria-hidden /> Export CSV
          </a>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Field label="Event">
          <Select value={f.action} onChange={(e) => set({ action: e.target.value })}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Outcome">
          <Select value={f.outcome} onChange={(e) => set({ outcome: e.target.value })}>
            <option value="">Any</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failure">Failed</option>
          </Select>
        </Field>
        <Field label="Organization">
          <Select value={f.company_id} onChange={(e) => set({ company_id: e.target.value })}>
            <option value="">Any</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Robot">
          <Input value={f.robot} onChange={(e) => set({ robot: e.target.value })} placeholder="saibya02" />
        </Field>
        <Field label="Search">
          <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="email, name, file…" />
        </Field>
        <Field label="From">
          <Input type="datetime-local" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="datetime-local" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </Field>
      </div>
      <QueryView query={q} rows={12}>
        {(res) =>
          res.items.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-8" />} title="No audit entries" description="Nothing matches these filters." />
          ) : (
            <>
              <DataTable
                caption="Audit log entries"
                dense
                rows={res.items}
                rowKey={(e) => e.id}
                columns={[
                  { key: 't', header: 'When', cell: (e) => <Time iso={e.at} /> },
                  {
                    key: 'w',
                    header: 'Who',
                    rowHeader: true,
                    cell: (e) => (
                      <span>
                        <span className="font-medium">{e.actor_name ?? e.actor_email ?? 'Unknown'}</span>
                        {e.actor_name && <span className="block text-xs text-muted">{e.actor_email}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'a',
                    header: 'Event',
                    cell: (e) => (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {ACTION_LABEL[e.action] ?? e.action}
                        {e.outcome !== 'success' && <Badge tone={e.outcome === 'denied' ? 'fault' : 'warn'}>{e.outcome}</Badge>}
                      </span>
                    ),
                  },
                  { key: 'r', header: 'Robot', cell: (e) => (e.robot_id ? <span className="font-mono">{e.robot_id}</span> : <span className="text-muted">—</span>) },
                  { key: 'o', header: 'Organization', cell: (e) => e.company_name ?? <span className="text-muted">—</span> },
                  { key: 'd', header: 'Details', className: 'max-w-md', cell: (e) => <span className="block truncate text-xs text-muted" title={JSON.stringify(e.detail)}>{summary(e)}</span> },
                  { key: 'i', header: 'IP', cell: (e) => <span className="font-mono text-xs">{e.ip ?? '—'}</span> },
                ]}
              />
              <Pagination page={res.page} limit={res.limit} total={res.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
    </>
  );
}
