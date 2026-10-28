'use client';

import { DashboardPage, RecentEvents } from '@/components/domain/dashboard';
import { useDocumentTitle } from '@/lib/hooks';

export default function FleetEventsPage() {
  useDocumentTitle('Events');
  return (
    <DashboardPage title="Events" description="The latest events from every robot. Open a robot to acknowledge its events.">
      {(d) => <RecentEvents d={d} />}
    </DashboardPage>
  );
}
