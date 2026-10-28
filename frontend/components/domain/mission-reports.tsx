'use client';

import type { MissionDetailDto, MissionListItemDto, Paginated, RobotDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarRange, FileDown, Moon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { missionReportPdf, summaryPdf, type ReportRobot } from '@/lib/reports';
import { downloadPatrolLog, istToday, PATROL_WINDOWS, patrolRange, type PatrolWindowId } from '@/lib/robot-reports';

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const thisMonth = () => today().slice(0, 7);

function useRobot(robotId: string) {
  return useQuery({ queryKey: ['robot', robotId, 'detail'], queryFn: () => api.get<RobotDetailDto>(`/robots/${robotId}`), staleTime: 60_000 });
}
const reportRobot = (r: RobotDetailDto): ReportRobot => ({ robot_id: r.robot_id, product_name: r.product_name, serial_number: r.serial_number, owner_company: r.owner_company });

/** Every mission of a robot started in [from, to), all pages. */
async function missionsBetween(robotId: string, from: Date, to: Date): Promise<MissionListItemDto[]> {
  const out: MissionListItemDto[] = [];
  for (let page = 1; ; page++) {
    const res = await api.get<Paginated<MissionListItemDto>>(`/robots/${robotId}/missions`, { from: from.toISOString(), to: to.toISOString(), page, limit: 200 });
    out.push(...res.items);
    if (out.length >= res.total || !res.items.length) return out;
  }
}

/** Daily / monthly mission summary PDFs for one robot (Missions tab). */
export function MissionReportsBar({ robotId }: { robotId: string }) {
  const robot = useRobot(robotId);
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [month, setMonth] = useState(thisMonth());
  const [busy, setBusy] = useState<'daily' | 'monthly' | null>(null);

  const run = async (kind: 'daily' | 'monthly') => {
    if (!robot.data) return;
    setBusy(kind);
    try {
      let from: Date;
      let to: Date;
      let label: string;
      if (kind === 'daily') {
        const [y, m, d] = day.split('-').map(Number);
        from = new Date(y, m - 1, d);
        to = new Date(y, m - 1, d + 1);
        label = from.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
      } else {
        const [y, m] = month.split('-').map(Number);
        from = new Date(y, m - 1, 1);
        to = new Date(y, m, 1);
        label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      }
      const missions = await missionsBetween(robotId, from, to);
      await summaryPdf({ kind, label, missions, robot: reportRobot(robot.data), odometerM: robot.data.odometer_m });
      toast.success(`${kind === 'daily' ? 'Daily' : 'Monthly'} summary downloaded (${missions.length} mission${missions.length === 1 ? '' : 's'})`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Mission reports" className="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div>
        <p className="text-sm font-semibold">Mission reports (PDF)</p>
        <p className="text-xs text-muted">Totals, distances and every mission of the period.</p>
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="size-3.5" aria-hidden /> Day
          </span>
          <Input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} className="h-9 w-40" />
        </label>
        <Button icon={<FileDown className="size-4" aria-hidden />} onClick={() => void run('daily')} loading={busy === 'daily'} disabled={!day || !robot.data}>
          Daily summary
        </Button>
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          <span className="inline-flex items-center gap-1">
            <CalendarRange className="size-3.5" aria-hidden /> Month
          </span>
          <Input type="month" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
        </label>
        <Button icon={<FileDown className="size-4" aria-hidden />} onClick={() => void run('monthly')} loading={busy === 'monthly'} disabled={!month || !robot.data}>
          Monthly summary
        </Button>
      </div>
      <PatrolLogControl robotId={robotId} />
    </section>
  );
}

/** Night surveillance / patrol log PDF (same report and periods as the client portal's). */
function PatrolLogControl({ robotId }: { robotId: string }) {
  const toast = useToast();
  const [date, setDate] = useState(istToday());
  const [windowId, setWindowId] = useState<PatrolWindowId>('day');
  const [from, setFrom] = useState('22:00');
  const [to, setTo] = useState('06:00');
  const range = patrolRange(windowId, from, to);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await downloadPatrolLog(robotId, date, range);
      toast.success(r.summary.online_s === 0 ? 'Log downloaded. The robot sent no data in this period.' : 'Night surveillance log downloaded');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-end gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
        <span className="inline-flex items-center gap-1">
          <Moon className="size-3.5" aria-hidden /> Patrol log
        </span>
        <span className="flex gap-2">
          <Input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value)} className="h-9 w-40" aria-label="Patrol log date" />
          <Select value={windowId} onChange={(e) => setWindowId(e.target.value as PatrolWindowId)} className="h-9 w-64" aria-label="Patrol log period">
            {PATROL_WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </Select>
          {windowId === 'custom' && (
            <>
              {/* A To time earlier than From ends on the next day. */}
              <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-28" aria-label="Patrol log from (IST)" title="From (IST)" />
              <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-28" aria-label="Patrol log to (IST)" title="To (IST); earlier than From ends on the next day" />
            </>
          )}
        </span>
      </label>
      <Button icon={<FileDown className="size-4" aria-hidden />} onClick={() => void run()} loading={busy} disabled={!date || !range.from || !range.to}>
        Night surveillance log
      </Button>
    </div>
  );
}

/** One mission's report PDF (mission page). */
export function MissionReportButton({ mission }: { mission: MissionDetailDto }) {
  const robot = useRobot(mission.robot_id);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      icon={<FileDown className="size-4" aria-hidden />}
      loading={busy}
      disabled={!robot.data}
      onClick={async () => {
        setBusy(true);
        try {
          await missionReportPdf(mission, reportRobot(robot.data!));
        } catch (err) {
          toast.error(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      Download report (PDF)
    </Button>
  );
}
