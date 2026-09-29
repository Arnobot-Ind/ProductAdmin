'use client';

import type { ArchiveSessionDetailDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Download, Film, RotateCcw, Timer, Trash2, Upload, Video } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { SessionStatusBadge, UploadBadge } from '@/components/archive/badges';
import { parseChunkTime } from '@/components/archive/player/use-clock';
import { SessionPlayer } from '@/components/archive/player/session-player';
import { StreamPlaceholder } from '@/components/archive/sensors/stream-placeholder';
import { Button, LinkButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Badge, InlineAlert, QueryView, Time } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCanAnywhere } from '@/lib/auth';
import { fmtDuration, fmtRelative } from '@/lib/format';
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

/** One recording: watch the cameras. Downloads of any data live on the Data downloads page. */
function VideoView({ d }: { d: ArchiveSessionDetailDto }) {
  const { session, cameras, access } = d;
  useDocumentTitle(`${session.robot_id} · ${session.session_id}`);
  const params = useSearchParams();
  const t = params.get('t');
  const canAnywhere = useCanAnywhere();
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();

  const remove = useMutation({
    mutationFn: () => (d.deleted_at ? api.post(`/archive/sessions/${session.id}/restore`) : api.del(`/archive/sessions/${session.id}`, { reason: reason.trim() || null })),
    onSuccess: () => {
      toast.success(d.deleted_at ? 'Recording restored' : 'Recording deleted');
      setDeleting(false);
      void qc.invalidateQueries({ queryKey: ['archive'] });
      if (!d.deleted_at) router.push(`/robots/${session.robot_id}?tab=videos`);
    },
    onError: toast.error,
  });

  // DVR segments may start before and end after the session, so the timeline covers both.
  const segStarts = cameras.flatMap((c) => c.segments.map((s) => s.start_ms));
  const segEnds = cameras.flatMap((c) => c.segments.map((s) => s.start_ms + s.duration_s * 1000));
  const sessionStart = session.started_at ? Date.parse(session.started_at) : Date.now();
  const start = Math.min(sessionStart, ...segStarts);
  const end = Math.max(session.ended_at ? Date.parse(session.ended_at) : start, start + 1000, ...segEnds);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/robots" className="hover:underline">
            Robots
          </Link>{' '}
          /{' '}
          <Link href={`/robots/${session.robot_id}`} className="font-mono hover:underline">
            {session.robot_id}
          </Link>{' '}
          /{' '}
          <Link href={`/robots/${session.robot_id}?tab=videos`} className="hover:underline">
            Videos
          </Link>{' '}
          / <span aria-current="page">{session.session_id}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-bold break-all sm:text-2xl">{session.session_id}</h1>
            <SessionStatusBadge status={session.status} />
            <UploadBadge upload={session.upload} status={session.status} />
            {session.simulated && <Badge tone="warn">Simulated</Badge>}
            {d.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            {canAnywhere('data.download') && !d.deleted_at && (
              <LinkButton href={`/downloads?robot=${session.robot_id}`} icon={<Download className="size-4" aria-hidden />} title="Download this robot's data">
                Export data
              </LinkButton>
            )}
            {access.delete && (
              <Button
                variant={d.deleted_at ? 'secondary' : 'ghost'}
                icon={d.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                onClick={() => (d.deleted_at ? remove.mutate() : setDeleting(true))}
                loading={remove.isPending && !!d.deleted_at}
              >
                {d.deleted_at ? 'Restore' : 'Delete'}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-muted">
          <Link href={`/robots/${session.robot_id}`} className="font-mono text-accent-text hover:underline">
            {session.robot_id}
          </Link>{' '}
          · {session.product_name}
          {session.trip && <> · {session.trip}</>}
        </p>
      </div>

      {d.deleted_at && (
        <InlineAlert tone="fault" title="This recording is deleted">
          Hidden from everyone else; the files are still in the archive, so it can be restored.{d.delete_reason && <> Reason: {d.delete_reason}</>}
        </InlineAlert>
      )}
      {session.status === 'active' && <InlineAlert tone="ok">Still recording: this page shows everything uploaded so far and refreshes by itself.</InlineAlert>}
      {session.status === 'interrupted' && (
        <InlineAlert tone="warn">This recording was never stopped and nothing was uploaded for over {d.interrupted_after_min} minutes (power or network lost). Everything uploaded plays below.</InlineAlert>
      )}

      {cameras.length ? (
        <SessionPlayer start={start} end={end} cameras={cameras} initialTime={t ? parseChunkTime(t) : undefined} />
      ) : (
        <StreamPlaceholder icon={<Video className="size-8" />} title="No camera video">
          {d.streams.video.reason}
        </StreamPlaceholder>
      )}

      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3 lg:grid-cols-5">
        <Info icon={<Clock className="size-4" />} label="Started" value={<Time iso={session.started_at} />} />
        <Info icon={<Clock className="size-4" />} label="Ended" value={session.ended_at ? <Time iso={session.ended_at} /> : session.status === 'active' ? 'Recording…' : '—'} />
        <Info icon={<Timer className="size-4" />} label="Duration" value={fmtDuration(session.duration_s)} />
        <Info icon={<Film className="size-4" />} label="Cameras" value={cameras.length ? cameras.map((c) => c.name).join(' · ') : 'None'} />
        <Info icon={<Upload className="size-4" />} label="Last upload" value={fmtRelative(session.last_upload_at)} />
      </dl>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        danger
        title="Delete this recording?"
        description="It disappears for everyone, including the customer. The files stay in the archive, so it can be restored. Recorded in the audit log."
        confirmLabel="Delete recording"
      >
        <Field label="Reason" hint="Optional; shown to admins who can restore it.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

function Info({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{value}</dd>
    </div>
  );
}
