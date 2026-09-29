'use client';

import type { MissionDetailDto, MissionFileDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Download, FileImage, FileVideo, HardDrive } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { GeoMap, MapLegend, type MapLine, type MapPoint } from '@/components/domain/geo-map';
import { MissionResultBadge } from '@/components/domain/status';
import { MissionReportButton } from '@/components/domain/mission-reports';
import { Badge, Card, EmptyState, KeyValue, Mono, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { fmtBytes, fmtDistance, fmtDuration, humanize } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

export default function MissionDetailPage() {
  const { robotId, missionId } = useParams<{ robotId: string; missionId: string }>();
  const id = decodeURIComponent(missionId);
  useDocumentTitle(`Mission ${id}`);
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['mission', id],
    queryFn: () => api.get<MissionDetailDto>(`/missions/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.result === 'in_progress' ? poll || 15_000 : false),
  });

  return (
    <QueryView query={q} rows={8}>
      {(m) =>
        m.robot_id === robotId ? (
          <MissionDetail m={m} />
        ) : (
          <EmptyState title="Mission not found" description={`${robotId} has no mission ${id}.`} />
        )
      }
    </QueryView>
  );
}

function MissionDetail({ m }: { m: MissionDetailDto }) {
  const { lines, points } = useMemo(() => {
    const lines: MapLine[] = [];
    const points: MapPoint[] = [];
    // Actual (wide, solid) first, planned (dashed) on top: when the robot follows the plan exactly,
    // the plan would otherwise be hidden underneath.
    if (m.actual_path?.coordinates.length) {
      const c = m.actual_path.coordinates;
      lines.push({ id: 'actual', coordinates: c, color: 'var(--map-actual)', width: 5 });
      points.push({ id: 'start', lon: c[0][0], lat: c[0][1], color: '#16a34a', label: 'Start' });
      points.push({ id: 'end', lon: c[c.length - 1][0], lat: c[c.length - 1][1], color: '#dc2626', label: 'End' });
    }
    if (m.planned_path?.coordinates.length) lines.push({ id: 'planned', coordinates: m.planned_path.coordinates, color: 'var(--map-planned)', dashed: true, width: 2.5 });
    return { lines, points };
  }, [m.planned_path, m.actual_path]);

  const hasPath = lines.length > 0;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
        <Link href="/robots" className="hover:underline">
          Robots
        </Link>{' '}
        /{' '}
        <Link href={`/robots/${m.robot_id}`} className="font-mono hover:underline">
          {m.robot_id}
        </Link>{' '}
        /{' '}
        <Link href={`/robots/${m.robot_id}?tab=missions`} className="hover:underline">
          Missions
        </Link>
      </nav>
      <PageHeader eyebrow="Mission report" title={<span className="font-mono">{m.mission_id}</span>} description={m.name ?? undefined} actions={
          <>
            <MissionResultBadge result={m.result} />
            <MissionReportButton mission={m} />
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Summary" className="xl:col-span-1">
          <KeyValue
            columns={1}
            items={[
              { label: 'Robot', value: <Link href={`/robots/${m.robot_id}`} className="font-mono text-accent-text hover:underline">{m.robot_id}</Link> },
              { label: 'Start', value: <Time iso={m.started_at} /> },
              { label: 'End', value: <Time iso={m.ended_at} /> },
              { label: 'Duration', value: fmtDuration(m.duration_s) },
              { label: 'Distance driven', value: fmtDistance(m.distance_m) },
              { label: 'Planned distance', value: fmtDistance(m.distance_planned_m) },
              {
                label: 'Waypoints reached',
                value: m.waypoints_total !== null ? `${m.waypoints_reached ?? 0} of ${m.waypoints_total}` : null,
              },
              { label: 'Result', value: <MissionResultBadge result={m.result} /> },
              { label: 'End reason', value: m.end_reason },
              {
                label: 'GCS report',
                value: m.gcs_report_received_at ? (
                  <span>
                    Received <Time iso={m.gcs_report_received_at} />
                  </span>
                ) : (
                  <Badge tone="warn">Not received yet</Badge>
                ),
              },
            ]}
          />
        </Card>

        <Card title="Map: planned vs actual path" className="xl:col-span-2">
          {hasPath ? (
            <>
              <GeoMap
                lines={lines}
                points={points}
                className="h-[28rem]"
                ariaLabel={`Map of mission ${m.mission_id}: planned path with ${m.planned_path?.coordinates.length ?? 0} points, actual path with ${m.actual_path?.coordinates.length ?? 0} points`}
              />
              <MapLegend
                items={[
                  { label: `Planned path (from GCS) · ${m.planned_path?.coordinates.length ?? 0} points`, color: 'var(--map-planned)', dashed: true },
                  { label: `Actual path (from robot) · ${m.actual_path?.coordinates.length ?? 0} points`, color: 'var(--map-actual)' },
                ]}
              />
            </>
          ) : (
            <EmptyState title="No path data" description="The planned path comes from the GCS report; the actual path from the robot's mission end message." />
          )}
        </Card>
      </div>

      <Card title="Files in S3" className="mt-6" bodyClassName="p-0">
        {m.files.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No files" description="Videos, MCAP recordings and images are stored in S3; the mission keeps only their paths." icon={<HardDrive className="size-8" />} />
          </div>
        ) : (
          <>
            <MediaPreviews files={m.files} />
            <DataTable
              caption="Mission files"
              rows={m.files}
              rowKey={(f) => f.id}
              columns={[
                { key: 'kind', header: 'Kind', cell: (f) => <Badge>{humanize(f.kind)}</Badge> },
                { key: 'path', header: 'S3 path', className: 'max-w-md', cell: (f) => <Mono className="break-all">{f.s3_path}</Mono> },
                { key: 'size', header: 'Size', align: 'right', cell: (f) => fmtBytes(f.size_bytes) },
                { key: 'at', header: 'Recorded', cell: (f) => <Time iso={f.created_at} /> },
                {
                  key: 'dl',
                  header: <span className="sr-only">Download</span>,
                  cell: (f) =>
                    f.download_url ? (
                      <a href={f.download_url} className="inline-flex items-center gap-1 text-accent-text hover:underline">
                        <Download className="size-4" aria-hidden /> Download<span className="sr-only"> {f.s3_path}</span>
                      </a>
                    ) : (
                      <span className="text-xs text-muted" title="Stored outside PMS-managed storage">External</span>
                    ),
                },
              ]}
            />
          </>
        )}
      </Card>
    </>
  );
}

function MediaPreviews({ files }: { files: MissionFileDto[] }) {
  const media = files.filter((f) => f.download_url && (f.kind === 'video' || f.kind === 'image')).slice(0, 6);
  if (!media.length) return null;
  return (
    <div className="grid gap-4 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-3">
      {media.map((f) => (
        <figure key={f.id} className="overflow-hidden rounded-md border border-border bg-surface-2">
          {f.kind === 'video' ? (
            <video controls preload="metadata" className="aspect-video w-full bg-black" src={f.download_url!}>
              <track kind="captions" />
            </video>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={f.download_url!} alt={`Mission image ${f.s3_path.split('/').pop()}`} className="aspect-video w-full object-cover" loading="lazy" />
          )}
          <figcaption className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted">
            {f.kind === 'video' ? <FileVideo className="size-3.5" aria-hidden /> : <FileImage className="size-3.5" aria-hidden />}
            <span className="truncate">{f.s3_path.split('/').pop()}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
