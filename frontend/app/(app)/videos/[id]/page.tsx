'use client';

import type { ArchiveFileDto, ArchiveSessionDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Download, FileJson, FileVideo, Info } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { SessionStatusBadge, UploadBadge } from '@/components/archive/badges';
import { parseChunkTime } from '@/components/archive/player/use-clock';
import { SessionPlayer } from '@/components/archive/player/session-player';
import { Select } from '@/components/ui/field';
import { Badge, Card, InlineAlert, KeyValue, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

export default function VideoPage() {
  const { id } = useParams<{ id: string }>();
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['archive', 'session', id],
    queryFn: () => api.get<ArchiveSessionDetailDto>(`/archive/sessions/${id}`),
    // A session that is still recording keeps gaining segments.
    refetchInterval: (query) => (query.state.data?.session.status === 'active' ? (poll === false ? 30_000 : poll) : false),
  });
  return <QueryView query={q} rows={8}>{(d) => <VideoView d={d} />}</QueryView>;
}

function VideoView({ d }: { d: ArchiveSessionDetailDto }) {
  const { session, cameras, files } = d;
  useDocumentTitle(`${session.robot_id} · ${session.session_id}`);
  const params = useSearchParams();
  const t = params.get('t');

  // DVR segments may start before and end after the session, so the timeline covers both.
  const segStarts = cameras.flatMap((c) => c.segments.map((s) => s.start_ms));
  const segEnds = cameras.flatMap((c) => c.segments.map((s) => s.start_ms + s.duration_s * 1000));
  const sessionStart = session.started_at ? Date.parse(session.started_at) : Date.now();
  const start = Math.min(sessionStart, ...segStarts);
  const end = Math.max(session.ended_at ? Date.parse(session.ended_at) : start, start + 1000, ...segEnds);
  const sessionJson = files.find((f) => f.name === 'session.json');
  const imu = files.filter((f) => f.sensor === 'imu');
  const lidar = files.filter((f) => f.sensor === 'lidar');

  return (
    <div className="flex flex-col gap-5">
      <div>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/videos" className="hover:underline">
            Videos
          </Link>{' '}
          /{' '}
          <Link href={`/robots/${session.robot_id}?tab=videos`} className="font-mono hover:underline">
            {session.robot_id}
          </Link>{' '}
          / <span aria-current="page">{session.session_id}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-bold break-all sm:text-2xl">{session.session_id}</h1>
          <SessionStatusBadge status={session.status} />
          <UploadBadge upload={session.upload} status={session.status} />
          {session.simulated && <Badge tone="warn">Simulated data</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted">
          <Link href={`/robots/${session.robot_id}`} className="font-mono text-accent-text hover:underline">
            {session.robot_id}
          </Link>{' '}
          · {session.product_name}
          {session.trip && <> · trip {session.trip}</>}
        </p>
        {session.status === 'active' && (
          <div className="mt-3">
            <InlineAlert tone="ok">Still recording. The player and downloads include everything uploaded so far; this page refreshes by itself.</InlineAlert>
          </div>
        )}
        {session.status === 'interrupted' && (
          <div className="mt-3">
            <InlineAlert tone="warn">
              This session was never stopped and nothing was uploaded for over {d.interrupted_after_min} minutes. The robot probably lost power or network. Everything
              uploaded is still playable and downloadable.
            </InlineAlert>
          </div>
        )}
      </div>

      <SessionPlayer start={start} end={end} cameras={cameras} initialTime={t ? parseChunkTime(t) : undefined} />

      <div className="grid items-start gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card title="Recording">
          <KeyValue
            columns={1}
            items={[
              { label: 'Started', value: <Time iso={session.started_at} /> },
              { label: 'Ended', value: session.ended_at ? <Time iso={session.ended_at} /> : session.status === 'active' ? 'Recording…' : '—' },
              { label: 'Duration', value: fmtDuration(session.duration_s) },
              { label: 'Camera video', value: `${fmtBytes(session.bytes.camera)} · ${session.cameras.length} camera(s)` },
              { label: 'LiDAR + IMU', value: fmtBytes(session.bytes.sensors) },
              { label: 'Files', value: session.file_count.toLocaleString() },
              { label: 'Last upload', value: <Time iso={session.last_upload_at} relative /> },
            ]}
          />
        </Card>

        <Card title="Download">
          {!d.mp4_available && (
            <div className="mb-3">
              <InlineAlert tone="warn">MP4 export needs ffmpeg on the backend server. Raw .ts segments can still be downloaded below (they play in VLC).</InlineAlert>
            </div>
          )}
          <ul className="grid gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-2">
            {cameras.map((c) => (
              <DownloadRow
                key={c.name}
                icon={<FileVideo className="size-4" aria-hidden />}
                title={`${c.name} video`}
                detail={`${fmtDuration(c.seconds)} · ${fmtBytes(c.bytes)} · one MP4 that plays on Windows, Mac and phones`}
              >
                {d.mp4_available ? (
                  <a
                    href={c.mp4_download_url}
                    download
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium whitespace-nowrap text-accent-fg hover:opacity-90"
                    title="Built on the server on first click (a stream copy), so it can take a few seconds to start"
                  >
                    <Download className="size-4" aria-hidden /> .mp4
                  </a>
                ) : null}
              </DownloadRow>
            ))}
            {imu.length > 0 && <ChunkRow title="IMU" detail="HWT905 samples as .csv.gz chunks" files={imu} />}
            {lidar.length > 0 && <ChunkRow title="LiDAR" detail="RPLIDAR scans as numpy .npz chunks" files={lidar} />}
            {sessionJson && (
              <DownloadRow icon={<FileJson className="size-4" aria-hidden />} title="session.json" detail="Session summary written by the robot">
                <a href={sessionJson.download_url} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-surface-2">
                  <Download className="size-4" aria-hidden /> .json
                </a>
              </DownloadRow>
            )}
          </ul>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Files stream from the archive bucket through the PMS server; nothing is stored on your computer until you download it.
          </p>
        </Card>
      </div>

      <details className="group rounded-lg border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-surface-2">
          <span className="transition-transform group-open:rotate-90" aria-hidden>
            ▸
          </span>
          All files and session.json
          <span className="ml-auto text-xs text-muted">{files.length} objects</span>
        </summary>
        <div className="grid gap-3 border-t border-border p-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FileTable files={files} />
          <pre className="max-h-[28rem] overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed">
            {d.manifest ? JSON.stringify(d.manifest, null, 2) : 'No session.json uploaded yet.'}
          </pre>
        </div>
      </details>
    </div>
  );
}

function DownloadRow({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 bg-surface px-3 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-mono text-sm font-medium">
          {icon}
          {title}
        </p>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
      </div>
      {children}
    </li>
  );
}

/** Sensor streams come in chunks: pick one to download. */
function ChunkRow({ title, detail, files }: { title: string; detail: string; files: ArchiveFileDto[] }) {
  const [pick, setPick] = useState(files[0]?.name ?? '');
  const f = files.find((x) => x.name === pick);
  return (
    <DownloadRow icon={<Download className="size-4" aria-hidden />} title={title} detail={`${detail} · ${files.length} chunk(s), ${fmtBytes(files.reduce((n, x) => n + x.size_bytes, 0))}`}>
      <span className="flex items-center gap-1.5">
        <Select aria-label={`${title} chunk`} value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 max-w-40 text-xs">
          {files.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name.split('/').pop()}
            </option>
          ))}
        </Select>
        {f && (
          <a href={f.download_url} className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-sm font-medium hover:bg-surface-2" aria-label={`Download ${f.name}`}>
            <Download className="size-4" aria-hidden />
          </a>
        )}
      </span>
    </DownloadRow>
  );
}

function FileTable({ files }: { files: ArchiveFileDto[] }) {
  const [kind, setKind] = useState('');
  const rows = kind ? files.filter((f) => f.kind === kind) : files;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Select aria-label="Filter files" value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 w-48 text-sm">
        <option value="">All files</option>
        <option value="camera">Camera segments</option>
        <option value="sensors">Sensor chunks</option>
        <option value="meta">Metadata</option>
      </Select>
      <div className="max-h-[28rem] overflow-auto">
        <DataTable
          caption="Files in this recording"
          dense
          rows={rows}
          rowKey={(f) => f.name}
          columns={[
            { key: 'name', header: 'File', rowHeader: true, cell: (f) => <Mono className="text-xs">{f.name}</Mono> },
            { key: 'start', header: 'Chunk start', cell: (f) => <Time iso={f.chunk_start} /> },
            { key: 'size', header: 'Size', align: 'right', cell: (f) => fmtBytes(f.size_bytes) },
            {
              key: 'dl',
              header: <span className="sr-only">Download</span>,
              align: 'right',
              cell: (f) => (
                <a href={f.download_url} className="inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline" aria-label={`Download ${f.name}`}>
                  <Download className="size-3.5" aria-hidden /> Download
                </a>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
