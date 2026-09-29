'use client';

import type { ArchiveStreamDto, ImuPreviewDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Activity, CloudOff, FileWarning } from 'lucide-react';
import { useMemo } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { InlineAlert, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { StreamPlaceholder } from './stream-placeholder';

const COLORS = ['#3b82f6', '#f59e0b', '#10b981'];
const GROUPS: { title: string; unit: string; keys: [string, string][] }[] = [
  { title: 'Acceleration', unit: 'm/s²', keys: [['ax', 'X'], ['ay', 'Y'], ['az', 'Z']] },
  { title: 'Angular rate', unit: '°/s', keys: [['gx', 'X'], ['gy', 'Y'], ['gz', 'Z']] },
  { title: 'Attitude', unit: '°', keys: [['roll', 'Roll'], ['pitch', 'Pitch'], ['yaw', 'Yaw']] },
];

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** IMU of one recording: accel, gyro and attitude over time, from the server-side preview (no raw download needed). */
export function ImuView({ sessionId, stream }: { sessionId: string; stream: ArchiveStreamDto }) {
  const q = useQuery({
    queryKey: ['archive', 'session', sessionId, 'imu'],
    queryFn: () => api.get<ImuPreviewDto>(`/archive/sessions/${sessionId}/sensors/imu`),
    enabled: stream.available,
    staleTime: 60_000,
  });
  const data = useMemo(() => {
    const d = q.data;
    if (!d) return [];
    return d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c === 't_ms' ? 't' : c, r[i]])) as Record<string, number | null>);
  }, [q.data]);

  if (!stream.available) {
    return (
      <StreamPlaceholder icon={<Activity className="size-8" />} title="No IMU data">
        {stream.reason}
      </StreamPlaceholder>
    );
  }
  if (q.isLoading) {
    return (
      <div role="status" aria-live="polite" className="grid gap-3 lg:grid-cols-3">
        <span className="sr-only">Loading IMU data…</span>
        {GROUPS.map((g) => (
          <Skeleton key={g.title} className="h-56" />
        ))}
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <StreamPlaceholder icon={<CloudOff className="size-8" />} title="Could not load the IMU preview" tone="fault" action={<Button size="sm" onClick={() => void q.refetch()}>Try again</Button>}>
        {errorMessage(q.error)}
      </StreamPlaceholder>
    );
  }
  const d = q.data;
  if (d.status === 'unavailable') {
    const storage = d.problem === 'storage_unavailable';
    return (
      <StreamPlaceholder
        icon={storage ? <CloudOff className="size-8" /> : <FileWarning className="size-8" />}
        title={storage ? 'IMU storage unreachable' : d.problem === 'missing' ? 'No IMU data' : 'IMU data could not be decoded'}
        tone={storage ? 'fault' : 'warn'}
        action={storage ? <Button size="sm" onClick={() => void q.refetch()}>Try again</Button> : undefined}
      >
        {d.message}
      </StreamPlaceholder>
    );
  }
  const from = data[0]?.t ?? 0;
  const to = data[data.length - 1]?.t ?? 0;
  return (
    <div className="flex flex-col gap-3">
      {d.status === 'partial' && d.message && <InlineAlert tone="warn">{d.message}</InlineAlert>}
      <div className="grid gap-4 lg:grid-cols-3">
        {GROUPS.map((g) => {
          const present = g.keys.filter(([k]) => data.some((r) => r[k] !== null));
          return (
            <figure key={g.title} className="min-w-0">
              <figcaption className="mb-1 text-sm font-medium">
                {g.title} <span className="text-muted">({g.unit})</span>
              </figcaption>
              {present.length === 0 ? (
                <StreamPlaceholder icon={<Activity className="size-6" />} title={`No ${g.title.toLowerCase()} columns`} className="min-h-0">
                  The IMU files do not contain these values.
                </StreamPlaceholder>
              ) : (
                <div className="h-48" role="img" aria-label={`${g.title} over time, ${present.map(([, n]) => n).join(', ')}, ${fmtDateTime(new Date(from!).toISOString())} to ${fmtDateTime(new Date(to!).toISOString())}`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                      <XAxis dataKey="t" type="number" domain={[from!, to!]} tickFormatter={(v) => timeFmt.format(new Date(v))} stroke="var(--text-muted)" fontSize={10} minTickGap={40} />
                      <YAxis stroke="var(--text-muted)" fontSize={10} width={52} domain={['auto', 'auto']} tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))} />
                      <Tooltip
                        labelFormatter={(v) => fmtDateTime(new Date(Number(v)).toISOString())}
                        formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : String(v))}
                        contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {present.map(([k, name], i) => (
                        <Line key={k} dataKey={k} name={name} stroke={COLORS[i]} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </figure>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        {d.samples_total.toLocaleString()} samples from {d.chunks_read} of {d.chunks_total} chunk(s), shown as {d.rows.length.toLocaleString()} points.
      </p>
    </div>
  );
}
