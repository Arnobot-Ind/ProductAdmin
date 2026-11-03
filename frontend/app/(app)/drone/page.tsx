'use client';

import { ExternalLink, Plane } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

/**
 * The drone's C12 camera, live, from the Mumbai relay: the H12 Pro remote carries it there through a reverse SSH
 * tunnel when its Settings → Internet link is on; go2rtc on the relay serves it over MSE, behind the relay's own login
 * (Arnobot-Ind/GCS: gcs/gcs_mobile/relay/ and gcs/gcs_mobile/docs/superpowers/specs/2026-11-02-internet-link-design.md).
 */
const DRONE_VIDEO_ORIGIN = 'https://drone.13-234-159-182.sslip.io'; // also in next.config.ts frame-src
const PLAYER = `${DRONE_VIDEO_ORIGIN}/stream.html?src=c12&mode=mse`;

export default function DroneLivePage() {
  useDocumentTitle('Drone live');
  const can = useCan();
  if (!can('robot.details')) {
    return <EmptyState title="Not available" description="The drone's live video is for Arnobot staff." icon={<Plane className="size-8" />} />;
  }
  return (
    <>
      <PageHeader
        eyebrow="Drone · H12 Pro remote"
        title="Drone live"
        description="The C12 camera, live through the Mumbai relay (about 1 s behind). It plays while the remote's Internet link is on and the drone is powered."
        actions={
          <a href={PLAYER} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2">
            <ExternalLink className="size-4" aria-hidden /> Open in a new tab
          </a>
        }
      />
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        <iframe
          src={PLAYER}
          title="Drone camera, live"
          className="aspect-video w-full"
          allow="autoplay; fullscreen"
          referrerPolicy="no-referrer"
        />
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
        <li>The relay asks for its own login the first time (user <code>drone</code>; ask the drone team for the password).</li>
        <li>The camera sends H.265: use Safari, or Chrome / Edge on a Mac or Windows PC with hardware video decoding. Firefox cannot play it.</li>
        <li>&ldquo;connection refused&rdquo; in the player means the remote is off or its Internet link is switched off.</li>
      </ul>
    </>
  );
}
