'use client';

import type { ClientSoftwareDto, LicenceState } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, EmptyState } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';

export function useClientSoftware(enabled = true) {
  return useQuery({ queryKey: ['portal', 'software'], queryFn: () => api.get<ClientSoftwareDto[]>('/client/software'), enabled, staleTime: 5 * 60_000 });
}

const LICENCE: Record<LicenceState, { tone: 'ok' | 'warn' | 'fault' | 'neutral'; label: string }> = {
  none: { tone: 'neutral', label: 'No expiry' },
  valid: { tone: 'ok', label: 'Valid' },
  expiring: { tone: 'warn', label: 'Expiring soon' },
  expired: { tone: 'fault', label: 'Expired' },
};

/** Arnobot software the organization runs (portal.software.view, 0021): versions and licence dates. */
export function SoftwareTable({ items, showRobot = true }: { items: ClientSoftwareDto[]; showRobot?: boolean }) {
  return (
    <DataTable
      caption="Software"
      rows={items}
      rowKey={(s) => s.id}
      empty={<EmptyState title="No software recorded" description="Arnobot has not recorded any software installs for you yet." />}
      columns={[
        { key: 'name', header: 'Software', rowHeader: true, cell: (s) => <span className="font-medium">{s.software.name}</span> },
        {
          key: 'version',
          header: 'Version',
          cell: (s) => (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span className="font-mono">{s.version}</span>
              {s.update_available && (
                <Badge tone="accent" title={`Latest: ${s.software.latest_version}`}>
                  Update {s.software.latest_version} available
                </Badge>
              )}
            </span>
          ),
        },
        ...(showRobot
          ? [
              {
                key: 'robot',
                header: 'Robot',
                cell: (s: ClientSoftwareDto) =>
                  s.robot_id ? (
                    <Link href={`/robots/${s.robot_id}`} className="font-mono font-semibold text-accent-text hover:underline">
                      {s.robot_id.toUpperCase()}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  ),
              },
            ]
          : []),
        { key: 'host', header: 'Installed on', cell: (s) => s.host_label ?? <span className="text-muted">—</span> },
        { key: 'seats', header: 'Seats', align: 'right', cell: (s) => (s.seats === null ? <span className="text-muted">—</span> : s.seats) },
        { key: 'installed', header: 'Installed', cell: (s) => fmtDate(s.installed_at) },
        {
          key: 'licence',
          header: 'Licence',
          cell: (s) => (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge tone={LICENCE[s.licence_state].tone}>{LICENCE[s.licence_state].label}</Badge>
              {s.licence_valid_until && <span className="text-xs text-muted">until {fmtDate(s.licence_valid_until)}</span>}
            </span>
          ),
        },
      ]}
    />
  );
}
