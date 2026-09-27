'use client';

import { EventsTable, type EventFilters } from '@/components/domain/events-table';
import { PageHeader } from '@/components/ui/misc';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';

export default function EventsPage() {
  useDocumentTitle('Events');
  const [params, setParams] = useUrlState();
  const filters: EventFilters = {
    robot: params.get('robot') ?? undefined,
    type: params.get('type') ?? undefined,
    severity: params.get('severity') ?? undefined,
    unacked: params.get('unacked') === 'true' || undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    page: Number(params.get('page') ?? 1) || 1,
  };
  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Event log"
        description="Append-only log of Abort, RTH, Alert, Fault and Update events. Times are capture times from the robot (shown in your local zone; hover for UTC)."
      />
      <EventsTable
        showRobotFilter
        filters={filters}
        onFilters={(p) =>
          setParams(
            Object.fromEntries(
              Object.entries(p).map(([k, v]) => [k, v === undefined || v === false ? null : k === 'page' && v === 1 ? null : String(v)]),
            ),
          )
        }
      />
    </>
  );
}
