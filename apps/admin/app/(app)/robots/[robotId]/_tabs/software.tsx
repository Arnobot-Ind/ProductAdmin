'use client';

import type { SoftwareDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, KeyValue, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';

/** Spec §3 row 4: reported by the robot at boot (`hello`); a history row is kept for every change. */
export function SoftwareTab({ robotId }: { robotId: string }) {
  const q = useQuery({ queryKey: ['robot', robotId, 'software'], queryFn: () => api.get<SoftwareDto>(`/robots/${robotId}/software`) });
  return (
    <QueryView query={q}>
      {(sw) =>
        !sw.current ? (
          <EmptyState title="No software reported yet" description="The robot reports its software and firmware versions in the hello message it sends at boot and after every reconnect." />
        ) : (
          <div className="flex flex-col gap-6">
            <Card title="Current">
              <KeyValue
                columns={3}
                items={[
                  { label: 'Software version', value: sw.current.sw_ver ? <Mono>{sw.current.sw_ver}</Mono> : null },
                  { label: 'Firmware version', value: sw.current.fw_ver ? <Mono>{sw.current.fw_ver}</Mono> : null },
                  { label: 'Last update', value: <Time iso={sw.last_update_at} /> },
                  {
                    label: 'Enabled features',
                    value: sw.current.enabled_features?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {sw.current.enabled_features.map((f) => (
                          <Badge key={f} tone="accent">
                            {f}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      'None reported'
                    ),
                  },
                ]}
              />
            </Card>
            <section aria-labelledby="sw-history">
              <h2 id="sw-history" className="mb-2 text-sm font-semibold">
                Update history
              </h2>
              <DataTable
                caption="Software update history"
                rows={sw.history}
                rowKey={(h) => h.id}
                columns={[
                  { key: 'at', header: 'Reported', rowHeader: true, cell: (h) => <Time iso={h.reported_at} /> },
                  { key: 'sw', header: 'Software', cell: (h) => (h.sw_ver ? <Mono>{h.sw_ver}</Mono> : '—') },
                  { key: 'fw', header: 'Firmware', cell: (h) => (h.fw_ver ? <Mono>{h.fw_ver}</Mono> : '—') },
                  { key: 'feat', header: 'Features', cell: (h) => h.enabled_features?.join(', ') || '—' },
                  { key: 'boot', header: 'Boot ID', cell: (h) => (h.boot_id ? <span className="font-mono text-xs">{h.boot_id.slice(0, 8)}</span> : '—') },
                ]}
              />
            </section>
          </div>
        )
      }
    </QueryView>
  );
}
