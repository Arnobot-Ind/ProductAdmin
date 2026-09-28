'use client';

import type { RobotArchiveDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { RobotLinkPanel, SessionsTable } from '@/components/archive/sessions-table';
import { Card, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { useLivePoll } from '@/lib/realtime';

/** This robot's camera recordings (video + sensors), newest first, and its upload link. */
export function VideosTab({ robotId }: { robotId: string }) {
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robotId, 'archive'],
    queryFn: () => api.get<RobotArchiveDto>(`/robots/${robotId}/archive`),
    refetchInterval: poll === false ? 60_000 : poll,
  });
  return (
    <QueryView query={q}>
      {(d) => (
        <div className="flex flex-col gap-5">
          <Card title="Upload link">
            <RobotLinkPanel link={d.link} />
          </Card>
          <section aria-labelledby="rec-h">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rec-h" className="text-sm font-semibold tracking-wide">
                Recordings
              </h2>
              <p className="text-xs text-muted">
                {d.sessions.length} session(s) · {fmtBytes(d.sessions.reduce((n, s) => n + s.bytes.total, 0))} stored
              </p>
            </div>
            <SessionsTable sessions={d.sessions} caption={`Recordings of ${robotId}`} empty="No recordings from this robot yet." />
          </section>
        </div>
      )}
    </QueryView>
  );
}
