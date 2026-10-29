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
        // Exactly one screen tall (top bar, page padding and title taken off), so the page never scrolls: the map takes
        // the room that is left; battery levels sit beside it on wide screens and under it, scrolling on their own, on small ones.
        <div className="flex h-[calc(100dvh-14rem)] min-h-[24rem] flex-col gap-5 xl:grid xl:grid-cols-[minmax(0,1fr)_20rem]">
          <FleetMap d={d} title="Robot positions" fill />
          <Card title="Battery by robot" actions={<span className="text-sm text-muted">Last reported</span>} className="flex max-h-44 shrink-0 flex-col xl:max-h-none xl:self-start" bodyClassName="min-h-0 overflow-y-auto p-5">
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
