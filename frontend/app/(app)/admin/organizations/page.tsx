'use client';

import type { OrganizationDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Building2, Plus, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ClientStatusBadge } from '@/components/domain/client-admin';
import { OrganizationDialog } from '@/components/domain/organization-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

/** Arnobot and its customers. Each customer organization owns robots and has its own team of users. */
export default function OrganizationsPage() {
  useDocumentTitle('Organizations');
  const can = useCan();
  const router = useRouter();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['organizations', 'list', includeDeleted],
    queryFn: () => api.get<OrganizationDto[]>('/organizations', { include_deleted: includeDeleted }),
    enabled: can('org.manage'),
  });

  if (!can('org.manage')) {
    return (
      <>
        <PageHeader title="Organizations" />
        <InlineAlert tone="fault">You don&apos;t have permission to manage organizations.</InlineAlert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Organizations"
        description="Customers (e.g. Adani) and Arnobot itself. Assign robots, set up each client (status, contract, features, software, credentials) and invite its team: they sign in to the client app and see only their organization’s robots and data."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
            New organization
          </Button>
        }
      />
      <div className="mb-3">
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
      </div>
      <QueryView query={q}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No organizations" icon={<Building2 className="size-8" />} />
          ) : (
            <DataTable
              caption="Organizations"
              rows={list}
              rowKey={(o) => o.id}
              onRowClick={(o) => router.push(`/admin/organizations/${o.id}`)}
              rowClassName={(o) => (o.deleted_at ? 'opacity-60' : undefined)}
              columns={[
                {
                  key: 'n',
                  header: 'Organization',
                  rowHeader: true,
                  cell: (o) => (
                    <Link href={`/admin/organizations/${o.id}`} className="font-semibold text-accent-text hover:underline">
                      {o.name}
                    </Link>
                  ),
                },
                {
                  key: 'k',
                  header: 'Type',
                  cell: (o) => (o.deleted_at ? <Badge tone="fault">Deleted</Badge> : o.kind === 'internal' ? <Badge tone="accent">Arnobot</Badge> : <Badge>Customer</Badge>),
                },
                { key: 'cs', header: 'Client status', cell: (o) => (o.client ? <ClientStatusBadge status={o.client.status} /> : <span className="text-muted">—</span>) },
                { key: 'cc', header: 'Code', cell: (o) => (o.client?.client_code ? <span className="font-mono">{o.client.client_code}</span> : <span className="text-muted">—</span>) },
                { key: 'r', header: 'Robots', align: 'right', cell: (o) => o.robot_count },
                { key: 'u', header: 'Users', align: 'right', cell: (o) => o.user_count },
                { key: 'sw', header: 'Software', align: 'right', cell: (o) => (o.client ? o.client.software_count : <span className="text-muted">—</span>) },
                { key: 'ce', header: 'Contract ends', cell: (o) => (o.client?.contract_end ? fmtDate(o.client.contract_end) : <span className="text-muted">—</span>) },
                { key: 'c', header: 'Contact', cell: (o) => (o.contact_name || o.contact_email ? [o.contact_name, o.contact_email].filter(Boolean).join(' · ') : <span className="text-muted">—</span>) },
                { key: 't', header: 'Created', cell: (o) => <Time iso={o.created_at} /> },
                {
                  key: 'e',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (o) =>
                    o.deleted_at ? null : (
                      <Link
                        href={`/admin/organizations/${o.id}?edit=1`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
                        aria-label={`Edit ${o.name}`}
                      >
                        <Pencil className="size-3.5" aria-hidden /> Edit
                      </Link>
                    ),
                },
              ]}
            />
          )
        }
      </QueryView>
      <OrganizationDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
