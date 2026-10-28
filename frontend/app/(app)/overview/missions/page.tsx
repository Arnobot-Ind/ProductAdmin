'use client';

import { MissionsPerDayChart, RankBars } from '@/components/domain/charts';
import { DashboardPage, MissionsWeek, RecentMissions, useFleetReport } from '@/components/domain/dashboard';
import { Card, QueryView } from '@/components/ui/misc';
import { useDocumentTitle } from '@/lib/hooks';

export default function FleetMissionsPage() {
  useDocumentTitle('Missions');
  const report = useFleetReport(30);
  return (
    <DashboardPage title="Missions" description="Mission results across the fleet. Each robot's full mission list is on its page, under Recordings.">
      {(d) => (
        <div className="flex flex-col gap-6">
          <MissionsWeek d={d} />
          <QueryView query={report} rows={4}>
            {(r) => (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Card title="Missions per day · last 30 days" actions={<span className="text-base font-semibold tabular-nums">{r.totals.total} missions</span>}>
                  <MissionsPerDayChart rows={r.daily} />
                </Card>
                <Card title="Missions per robot · last 30 days">
                  <RankBars
                    rows={r.robots.map((x) => ({ key: x.robot_id, label: x.robot_id, value: x.missions.total, display: String(x.missions.total), detail: `${x.robot_id}: ${x.missions.total} missions, ${x.missions.completed} completed` }))}
                    empty="No missions in the last 30 days."
                  />
                </Card>
              </div>
            )}
          </QueryView>
          <RecentMissions d={d} />
        </div>
      )}
    </DashboardPage>
  );
}
