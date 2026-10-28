'use client';

import { CLIENT_FEATURES } from '@arnobot/message-schema';
import { SoftwareTable, useClientSoftware } from '@/components/client/client-software';
import { InlineAlert, PageHeader, QueryView } from '@/components/ui/misc';
import { useFeature, useMe } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

/** The Arnobot software the organization runs, its versions and licence dates (portal.software.view). */
export default function SoftwarePage() {
  useDocumentTitle('Software');
  const me = useMe();
  const allowed = useFeature()(CLIENT_FEATURES.softwareView);
  const q = useClientSoftware(allowed);
  return (
    <>
      <PageHeader eyebrow={me.organization.name} title="Software" description="Arnobot software in use at your organization: versions, available updates and licence dates." />
      {allowed ? (
        <QueryView query={q}>{(items) => <SoftwareTable items={items} />}</QueryView>
      ) : (
        <InlineAlert tone="accent">Software details are not part of your access. Ask a Manager at {me.organization.name} if you need them.</InlineAlert>
      )}
    </>
  );
}
