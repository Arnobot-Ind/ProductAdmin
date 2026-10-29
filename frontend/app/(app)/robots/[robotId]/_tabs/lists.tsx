'use client';

import { useState } from 'react';
import { dayBounds } from '@/components/domain/activity-calendar';
import { EventsTable, type EventFilters } from '@/components/domain/events-table';
import { MissionReportsBar } from '@/components/domain/mission-reports';
import { MissionsTable, type MissionFilters } from '@/components/domain/missions-table';

/** `day` (IST, YYYY-MM-DD) limits the list to that day; the table's own filters still apply. */
export function RobotMissionsTab({ robotId, day }: { robotId: string; day?: string | null }) {
  // The calendar's day becomes the date filter (still editable here); clearing the day clears it.
  const [filters, setFilters] = useState<MissionFilters>({ page: 1, ...(day ? dayBounds(day) : {}) });
  const [shownDay, setShownDay] = useState(day);
  if (shownDay !== day) {
    setShownDay(day);
    setFilters((f) => ({ ...f, page: 1, ...(day ? dayBounds(day) : { from: undefined, to: undefined }) }));
  }
  return (
    <>
      {!day && <MissionReportsBar robotId={robotId} />}
      <MissionsTable robotId={robotId} filters={filters} onFilters={(p) => setFilters((f) => ({ ...f, ...p }))} />
    </>
  );
}

export function RobotEventsTab({ robotId, day }: { robotId: string; day?: string | null }) {
  // The calendar's day becomes the date filter (still editable here); clearing the day clears it.
  const [filters, setFilters] = useState<EventFilters>({ page: 1, ...(day ? dayBounds(day) : {}) });
  const [shownDay, setShownDay] = useState(day);
  if (shownDay !== day) {
    setShownDay(day);
    setFilters((f) => ({ ...f, page: 1, ...(day ? dayBounds(day) : { from: undefined, to: undefined }) }));
  }
  return <EventsTable robotId={robotId} filters={filters} onFilters={(p) => setFilters((f) => ({ ...f, ...p }))} />;
}
