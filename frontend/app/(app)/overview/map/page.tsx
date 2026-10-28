'use client';

import { RankBars } from '@/components/domain/charts';
import { DashboardPage, FleetMap } from '@/components/domain/dashboard';
import { Card } from '@/components/ui/misc';
import { useDocumentTitle } from '@/lib/hooks';

export default function FleetMapPage() {
  useDocumentTitle('Fleet map');
  return (
    <DashboardPage title="Fleet map">
      {(d) => (
        <div className="flex flex-col gap-6">
          <FleetMap d={d} />
          <Card title="Battery by robot" actions={<span className="text-sm text-muted">Last reported level</span>}>
            <RankBars
              rows={d.fleet.filter((r) => r.battery_pct !== null).map((r) => ({ key: r.robot_id, label: r.robot_id, value: r.battery_pct!, display: `${Math.round(r.battery_pct!)} %` }))}
              empty="No robot has reported a battery level yet."
              scaleMax={100}
            />
          </Card>
        </div>
      )}
    </DashboardPage>
  );
}
