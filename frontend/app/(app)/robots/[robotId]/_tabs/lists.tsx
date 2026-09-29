'use client';

import { useState } from 'react';
import { EventsTable, type EventFilters } from '@/components/domain/events-table';
import { MissionReportsBar } from '@/components/domain/mission-reports';
import { MissionsTable, type MissionFilters } from '@/components/domain/missions-table';

export function RobotMissionsTab({ robotId }: { robotId: string }) {
  const [filters, setFilters] = useState<MissionFilters>({ page: 1 });
  return (
    <>
      <MissionReportsBar robotId={robotId} />
      <MissionsTable robotId={robotId} filters={filters} onFilters={(p) => setFilters((f) => ({ ...f, ...p }))} />
    </>
  );
}

export function RobotEventsTab({ robotId }: { robotId: string }) {
  const [filters, setFilters] = useState<EventFilters>({ page: 1 });
  return <EventsTable robotId={robotId} filters={filters} onFilters={(p) => setFilters((f) => ({ ...f, ...p }))} />;
}
