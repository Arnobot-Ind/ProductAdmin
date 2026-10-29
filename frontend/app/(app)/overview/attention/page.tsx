'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { DashboardDto, EventDto } from '@arnobot/message-schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { attentionItems, AttentionList, DashboardPage, faultTitle } from '@/components/domain/dashboard';
import { Button } from '@/components/ui/button';
import { Card, EmptyState } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtWhen, humanize } from '@/lib/format';
import { useDocumentTitle, useNow } from '@/lib/hooks';

/**
 * Needs attention: the problems themselves, not a list of robots. Faults and alerts still active right now
 * (from each robot's latest event per code), then critical events nobody has acknowledged yet, each with its
 * robot, message and time, and an Acknowledge button for people who may acknowledge.
 */
export default function AttentionPage() {
  useDocumentTitle('Needs attention');
  return (
    <DashboardPage title="Needs attention" description="Active faults and critical events nobody has acknowledged yet, most urgent first.">
      {(d) => <Attention d={d} />}
    </DashboardPage>
  );
}

function Attention({ d }: { d: DashboardDto }) {
  const critical = d.active_faults.filter((f) => f.severity === 'critical');
  const warnings = d.active_faults.filter((f) => f.severity !== 'critical');
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Count label="Critical errors happening now" hint="Reported by a robot and not cleared yet" value={critical.length} tone="fault" icon={<AlertOctagon className="size-6" />} />
        <Count label="Warnings happening now" hint="Not cleared yet" value={warnings.length} tone="warn" icon={<AlertTriangle className="size-6" />} />
        <Count label="Critical alerts not seen yet" hint="No one has acknowledged them, fixed or not" value={d.unacked_critical_events} tone="fault" icon={<AlertOctagon className="size-6" />} />
      </dl>

      <section aria-labelledby="active-h">
        <h2 id="active-h" className="mb-3 text-xl font-semibold">
          Active right now
        </h2>
        <AttentionList items={attentionItems({ ...d, critical_event_groups: [], warranty_expiring: [] })} />
      </section>

      <CriticalEvents events={d.critical_events} total={d.unacked_critical_events} />

      {d.warranty_expiring.length > 0 && (
        <section aria-labelledby="warranty-h">
          <h2 id="warranty-h" className="mb-3 text-xl font-semibold">
            Warranties ending in 30 days
          </h2>
          <AttentionList items={attentionItems({ ...d, active_faults: [], critical_event_groups: [] })} />
        </section>
      )}
    </div>
  );
}

function Count({ label, hint, value, tone, icon }: { label: string; hint: string; value: number; tone: 'fault' | 'warn'; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
      <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-xl', value ? (tone === 'fault' ? 'bg-fault-bg text-fault' : 'bg-warn-bg text-warn') : 'bg-surface-2 text-muted')} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-base text-muted">{label}</dt>
        <dd className="text-3xl font-semibold tabular-nums">{value}</dd>
        <dd className="text-sm text-muted">{hint}</dd>
      </div>
    </div>
  );
}

/** Critical events nobody has acknowledged (the newest 20), with Acknowledge for each and for all shown. */
function CriticalEvents({ events, total }: { events: EventDto[]; total: number }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(30_000);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['events'] });
  };
  const ackOne = useMutation({
    mutationFn: (id: string) => api.post<EventDto>(`/events/${id}/ack`),
    onSuccess: () => {
      toast.success('Event acknowledged');
      done();
    },
    onError: toast.error,
  });
  const ackAll = useMutation({
    mutationFn: () => api.post<{ acknowledged: number }>('/events/ack', { ids: events.map((e) => e.id) }),
    onSuccess: (r) => {
      toast.success(`${r.acknowledged} event${r.acknowledged === 1 ? '' : 's'} acknowledged`);
      done();
    },
    onError: toast.error,
  });
  const canAck = can('event.ack');
  return (
    <Card
      title={`Critical alerts nobody has acknowledged yet${total > events.length ? ` (newest ${events.length} of ${total})` : ''}`}
      actions={
        canAck && events.length > 1 ? (
          <Button size="sm" icon={<CheckCheck className="size-4" aria-hidden />} onClick={() => ackAll.mutate()} loading={ackAll.isPending}>
            Acknowledge all shown
          </Button>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      {events.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Nothing to acknowledge" description="Every critical event has been seen by someone." />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-fault-bg text-fault" aria-hidden>
                <AlertOctagon className="size-5" />
              </span>
              <div className="min-w-0 flex-1 basis-64">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-base font-semibold">{faultTitle(e.code, humanize(e.type))}</span>
                  <RobotRef id={e.robot_id} href={`/robots/${e.robot_id}?tab=events`} detail={false} className="text-sm" />
                </p>
                <p className="text-sm text-muted">{e.message}</p>
              </div>
              <span className="text-right text-sm">
                <span className="block font-medium">{fmtAgo(e.ts, now)}</span>
                <span className="block text-muted">{fmtWhen(e.ts, now)}</span>
              </span>
              {canAck && (
                <Button size="sm" onClick={() => ackOne.mutate(e.id)} loading={ackOne.isPending && ackOne.variables === e.id}>
                  Acknowledge
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
