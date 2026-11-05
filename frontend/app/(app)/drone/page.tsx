'use client';

import { ExternalLink, Plane } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

/**
 * The drone's C12 camera and live stats, from the Mumbai relay: the H12 Pro remote carries its video and MAVLink there
 * through reverse SSH tunnels when its Settings → Internet link is on; the relay's live page (go2rtc over MSE, and the
 * stats from drone-telemetry.py) has no login of its own: it sits under a random path (the link key below), so this page,
 * behind the PMS login and robot.details, is how people reach it
 * (Arnobot-Ind/GCS: gcs/gcs_mobile/relay/ and gcs/gcs_mobile/docs/superpowers/specs/2026-11-02-internet-link-design.md).
 */
const DRONE_VIDEO_ORIGIN = 'https://drone.13-234-159-182.sslip.io'; // also in next.config.ts frame-src
const DRONE_LINK = '420c6d9269626e5c9d5c2dce0532982a'; // the relay's link key (gcs_mobile relay/deploy.sh prints it; rotate there, then here)
const PLAYER = `${DRONE_VIDEO_ORIGIN}/${DRONE_LINK}/live.html`;

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
        actions={
          <a href={PLAYER} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2">
            <ExternalLink className="size-4" aria-hidden /> Open in a new tab
          </a>
        }
      />
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        <iframe
          src={PLAYER}
          title="Drone camera and stats, live"
          className="h-[calc(100vh-9.5rem)] min-h-[520px] w-full" /* the whole frame on screen: every stat at once */
          allow="autoplay; fullscreen"
          referrerPolicy="no-referrer"
        />
      </div>
      <details className="mt-2 text-sm text-muted">
        <summary className="cursor-pointer">Help</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>The C12 camera and the drone&rsquo;s live stats through the Mumbai relay, about 1 s behind: live while the remote&rsquo;s Internet link is on and the drone is powered.</li>
        <li>The link in &ldquo;Open in a new tab&rdquo; works without a login: keep it inside the team.</li>
        <li>The camera sends H.265: use Safari, or Chrome / Edge on a Mac or Windows PC with hardware video decoding. Firefox cannot play it.</li>
        <li>&ldquo;connection refused&rdquo; in the player means the remote is off or its Internet link is switched off.</li>
      </ul>
      </details>
    </>
  );
}
