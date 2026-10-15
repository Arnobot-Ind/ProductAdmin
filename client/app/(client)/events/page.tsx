'use client';

import { CLIENT_FEATURES } from '@arnobot/message-schema';
import { useRobotOptions } from '@/components/client/access-editor';
import { ClientEvents } from '@/components/client/client-events';
import { InlineAlert, PageHeader } from '@/components/ui/misc';
import { useFeature, useMe } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

/** Events and alerts across the robots the user may see (portal.events.view). */
export default function EventsPage() {
  useDocumentTitle('Events');
  const me = useMe();
  const allowed = useFeature()(CLIENT_FEATURES.eventsView);
  const robots = useRobotOptions();
  return (
    <>
      <PageHeader eyebrow={me.organization.name} title="Events" description="Alerts, faults, aborted missions and returns home reported by your robots. Times are IST." />
      {allowed ? (
        <ClientEvents robots={robots.data?.items ?? []} />
      ) : (
        <InlineAlert tone="accent">Events are not part of your access. Ask a Manager at {me.organization.name} if you need them.</InlineAlert>
      )}
    </>
  );
}
