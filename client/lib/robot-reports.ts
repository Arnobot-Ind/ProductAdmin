'use client';

/**
 * The four reports of a robot, shared by the admin robot page (Missions tab) and the client portal robot page
 * (Reports tab), so both download the same PDFs:
 *
 *   mission report            one mission run
 *   day summary               every mission of one IST day
 *   monthly summary           every mission of one IST month
 *   night surveillance log    patrol report for an IST window (the GCS "Night Surveillance Report" layout)
 *
 * Everything goes through the robot.read report routes, so customers and Arnobot staff use the same endpoints.
 */
import type { ClientMissionDto, ClientMissionReportDto, ClientMissionsDto, DayReportDto, RobotDetailDto } from '@arnobot/message-schema';
import { api } from './api';
import { downloadPatrolReport } from './patrol-report';
import { missionReportPdf, summaryPdf, type ReportRobot } from './reports';

const IST = 'Asia/Kolkata';
/** IST calendar day `daysAgo` days back, YYYY-MM-DD. */
export const istToday = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-CA', { timeZone: IST });
/** Last IST day of a YYYY-MM month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Patrol log windows; `to` at or before `from` runs into the next morning. */
export const PATROL_WINDOWS = [
  { id: 'night', label: 'Night (18:00 – 06:00 next day)', from: '18:00', to: '06:00' },
  { id: 'late', label: 'Night patrol (22:00 – 24:00)', from: '22:00', to: '24:00' },
  { id: 'day', label: 'Whole day (00:00 – 24:00)', from: '00:00', to: '24:00' },
  { id: 'daytime', label: 'Daytime (06:00 – 18:00)', from: '06:00', to: '18:00' },
  { id: 'custom', label: 'Custom…', from: '', to: '' },
] as const;
export type PatrolWindowId = (typeof PATROL_WINDOWS)[number]['id'];
export const patrolRange = (id: PatrolWindowId, from: string, to: string) => {
  const w = PATROL_WINDOWS.find((x) => x.id === id)!;
  return id === 'custom' ? { from, to } : { from: w.from, to: w.to };
};

const reportRobot = (r: RobotDetailDto): ReportRobot => ({ robot_id: r.robot_id, product_name: r.product_name, serial_number: r.serial_number, owner_company: r.owner_company });

/** Every mission of a robot started in IST days [from, to], all pages. */
export async function missionsBetween(robotId: string, from: string, to: string): Promise<ClientMissionDto[]> {
  const out: ClientMissionDto[] = [];
  for (let page = 1; ; page++) {
    const res = await api.get<ClientMissionsDto>(`/robots/${robotId}/reports/missions`, { from, to, page, limit: 200 });
    out.push(...res.items);
    if (out.length >= res.total || !res.items.length) return out;
  }
}
/** 1. Mission report PDF of one mission. */
export async function downloadMissionReport(robot: RobotDetailDto, missionId: string): Promise<void> {
  const m = await api.get<ClientMissionReportDto>(`/robots/${robot.robot_id}/reports/missions/${encodeURIComponent(missionId)}`);
  await missionReportPdf(m, reportRobot(robot));
}

/** 2. Day summary PDF: every mission of one IST day. Returns how many missions it lists. */
export async function downloadDaySummary(robot: RobotDetailDto, date: string): Promise<number> {
  const missions = await missionsBetween(robot.robot_id, date, date);
  await summaryPdf({ kind: 'daily', period: date, missions, robot: reportRobot(robot) });
  return missions.length;
}

/** 3. Monthly summary PDF: every mission of one IST month (YYYY-MM). Returns how many missions it lists. */
export async function downloadMonthSummary(robot: RobotDetailDto, month: string): Promise<number> {
  const missions = await missionsBetween(robot.robot_id, `${month}-01`, monthEnd(month));
  await summaryPdf({ kind: 'monthly', period: month, missions, robot: reportRobot(robot) });
  return missions.length;
}

/** 4. Night surveillance / patrol log PDF for an IST window. Returns the report (e.g. to say "no data"). */
export async function downloadPatrolLog(robotId: string, date: string, range: { from: string; to: string }): Promise<DayReportDto> {
  const report = await api.get<DayReportDto>(`/robots/${robotId}/reports/day`, { date, ...range });
  await downloadPatrolReport(report);
  return report;
}
