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
        // The map is the page: full width and most of the screen height; battery levels sit beside it on wide screens.
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
          <FleetMap d={d} className="h-[calc(100dvh-19rem)] min-h-[28rem]" />
          <Card title="Battery by robot" actions={<span className="text-sm text-muted">Last reported</span>}>
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
