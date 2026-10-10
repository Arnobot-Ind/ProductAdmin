'use client';

import type { LiveStateDto, RobotDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { RobotStatusBadge } from '@/components/common/status';
import { RobotMissionsOverview, RobotMissionsTab } from '@/components/client/robot-missions';
import { RobotReportsTab } from '@/components/client/robot-report';
import { Card, EmptyState, LoadingBlock, QueryView } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';

// Leaflet is client-only.
const ReportMap = dynamic(() => import('@/components/client/report-map').then((m) => m.ReportMap), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading map…</div>,
});

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'missions', label: 'Missions' },
  { id: 'reports', label: 'Reports' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} %`);

/** Client view of one robot: Overview (live + mission stats), Missions, Reports (calendar: mission report, day / monthly summary, night surveillance log). No video. */
export default function PortalRobotPage() {
  const { robotId } = useParams<{ robotId: string }>();
  useDocumentTitle(robotId.toUpperCase());
  const robot = useQuery({ queryKey: ['robot', robotId, 'detail'], queryFn: () => api.get<RobotDetailDto>(`/robots/${robotId}`), refetchInterval: 30_000 });
  return <QueryView query={robot} rows={8}>{(r) => <RobotView robot={r} />}</QueryView>;
}

function RobotView({ robot }: { robot: RobotDetailDto }) {
  const [params, setParams] = useUrlState();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'overview';
  const go = (id: string) => setParams({ tab: id === 'overview' ? null : id });
  const live = useQuery({
    queryKey: ['robot', robot.robot_id, 'live'],
    queryFn: () => api.get<LiveStateDto>(`/robots/${robot.robot_id}/live`),
    refetchInterval: 30_000,
  });
  const name = robot.robot_id.toUpperCase();

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/robots" className="hover:underline">
          Robots
        </Link>{' '}
        / <span aria-current="page">{name}</span>
      </nav>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{name}</h1>
          <RobotStatusBadge lastSeenAt={robot.last_seen_at} showAge />
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Fact label="Model">{robot.product_name}</Fact>
          <Fact label="Last seen">{robot.last_seen_at ? fmtRelative(robot.last_seen_at) : 'Never'}</Fact>
          <Fact label="Battery">{pct(live.data?.battery.pct ?? robot.battery_pct)}</Fact>
          <Fact label="Current mission">{robot.current_mission_id ? (robot.current_mission_name ?? robot.current_mission_id) : 'None'}</Fact>
        </dl>
      </header>

      <div>
        <Tabs label="Robot sections" items={TABS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={go} />
        <TabPanel id={tab}>
          {tab === 'overview' && (
            <div className="flex flex-col gap-5">
              <Card title="Live location">
                {live.data?.position ? (
                  <div className="h-80">
                    <ReportMap position={{ lat: live.data.position.lat, lon: live.data.position.lon, label: name }} height="100%" />
                  </div>
                ) : live.isLoading ? (
                  <LoadingBlock rows={3} label="Loading location" />
                ) : (
                  <EmptyState title="No position yet" description="The robot has not reported a GPS position." />
                )}
              </Card>
              <RobotMissionsOverview robotId={robot.robot_id} onAllMissions={() => go('missions')} />
            </div>
          )}
          {tab === 'missions' && <RobotMissionsTab robotId={robot.robot_id} />}
          {tab === 'reports' && <RobotReportsTab robot={robot} />}
        </TabPanel>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
