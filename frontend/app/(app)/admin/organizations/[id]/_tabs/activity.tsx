'use client';

import type { AuditEntryDto, OrganizationDetailDto, Paginated } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, EmptyState, Pagination, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ACTION_LABEL, auditSummary } from '@/lib/audit';

/** The organization's audit trail: its users' sign-ins and data access, and every change made to it. */
export function ActivityTab({ org }: { org: OrganizationDetailDto }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', { company_id: org.id }, page],
    queryFn: () => api.get<Paginated<AuditEntryDto>>('/audit', { company_id: org.id, page, limit: 50 }),
    placeholderData: (prev) => prev,
  });
  return (
    <Card title="Activity" actions={<Link href="/admin/audit" className="text-sm text-accent-text hover:underline">Full audit log</Link>}>
      <QueryView query={q} rows={10}>
        {(res) =>
          res.items.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-8" />} title="No activity yet" />
          ) : (
            <>
              <DataTable
                caption={`Activity of ${org.name}`}
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
                  { key: 'd', header: 'Details', className: 'max-w-md', cell: (e) => <span className="block truncate text-xs text-muted" title={JSON.stringify(e.detail)}>{auditSummary(e)}</span> },
                ]}
              />
              <Pagination page={res.page} limit={res.limit} total={res.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}
