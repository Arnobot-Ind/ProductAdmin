'use client';

import type { RobotArchiveDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { RobotLinkPanel, SessionsTable } from '@/components/archive/sessions-table';
import { Card, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { useLivePoll } from '@/lib/realtime';

const istDayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** This robot's camera recordings (video + sensors), newest first, and its upload link; `day` (IST) shows one day only. */
export function VideosTab({ robotId, day }: { robotId: string; day?: string | null }) {
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robotId, 'archive'],
    queryFn: () => api.get<RobotArchiveDto>(`/robots/${robotId}/archive`),
    refetchInterval: poll === false ? 300_000 : poll,
  });
  return (
    <QueryView query={q}>
      {(d) => {
        const sessions = day ? d.sessions.filter((s) => s.started_at && istDayOf(s.started_at) === day) : d.sessions;
        return (
        <div className="flex flex-col gap-5">
          {!day && (
            <Card title="Upload link">
              <RobotLinkPanel link={d.link} />
            </Card>
          )}
          <section aria-labelledby="rec-h">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rec-h" className="text-sm font-semibold tracking-wide">
                Recordings
              </h2>
              <p className="text-xs text-muted">
                {sessions.length} session(s) · {fmtBytes(sessions.reduce((n, s) => n + s.bytes.total, 0))} stored
              </p>
            </div>
            <SessionsTable sessions={sessions} caption={`Recordings of ${robotId}`} empty={day ? 'No recordings on this day.' : 'No recordings from this robot yet.'} />
          </section>
        </div>
        );
      }}
    </QueryView>
  );
}
