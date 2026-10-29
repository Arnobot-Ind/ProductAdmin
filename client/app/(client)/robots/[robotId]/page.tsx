'use client';

import { CLIENT_FEATURES, type LiveStateDto, type RobotDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { RobotStatusBadge } from '@/components/common/status';
import { ClientEvents } from '@/components/client/client-events';
import { DetectionsTab } from '@/components/client/detections';
import { SoftwareTable, useClientSoftware } from '@/components/client/client-software';
import { RobotMissionsOverview, RobotMissionsTab } from '@/components/client/robot-missions';
import { RobotReportsTab } from '@/components/client/robot-report';
import { RobotTelemetryTab } from '@/components/client/robot-telemetry';
import { Card, EmptyState, LoadingBlock, QueryView } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useFeature } from '@/lib/auth';
import { fmtRelative } from '@/lib/format';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { BesideBack } from '@/components/ui/back-button';
import { Band, BandFact, BandMeter } from '@/components/ui/band';

// Leaflet is client-only.
const ReportMap = dynamic(() => import('@/components/client/report-map').then((m) => m.ReportMap), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading map…</div>,
});

/** Each tab needs its client-app feature (0021); Overview is always there. */
const TABS = [
  { id: 'overview', label: 'Overview', feature: null },
  { id: 'missions', label: 'Missions', feature: CLIENT_FEATURES.missionsView },
  { id: 'reports', label: 'Reports', feature: CLIENT_FEATURES.reportsView },
  { id: 'detections', label: 'Detections', feature: CLIENT_FEATURES.detectionsView },
  { id: 'telemetry', label: 'Battery & health', feature: CLIENT_FEATURES.telemetryView },
  { id: 'events', label: 'Events', feature: CLIENT_FEATURES.eventsView },
] as const;
type TabId = (typeof TABS)[number]['id'];


/**
 * Client view of one robot: Overview (live, location, mission stats, software), Missions, Reports (calendar: mission
 * report, day / monthly summary, night surveillance log), Detections (camera snapshots), Battery & health, Events — each as the user's features allow.
 * No video, no CSV.
 */
export default function PortalRobotPage() {
  const { robotId } = useParams<{ robotId: string }>();
  useDocumentTitle(robotId.toUpperCase());
  const robot = useQuery({ queryKey: ['robot', robotId, 'detail'], queryFn: () => api.get<RobotDetailDto>(`/robots/${robotId}`), refetchInterval: 60_000 });
  return <QueryView query={robot} rows={8}>{(r) => <RobotView robot={r} />}</QueryView>;
}

function RobotView({ robot }: { robot: RobotDetailDto }) {
  const has = useFeature();
  const tabs = TABS.filter((t) => !t.feature || has(t.feature));
  const [params, setParams] = useUrlState();
  const requested = params.get('tab');
  const tab: TabId = tabs.some((t) => t.id === requested) ? (requested as TabId) : 'overview';
  const location = has(CLIENT_FEATURES.robotsLocation);
  const software = useClientSoftware(has(CLIENT_FEATURES.softwareView));
  const robotSoftware = (software.data ?? []).filter((s) => s.robot_id === robot.robot_id);
  const go = (id: string) => setParams({ tab: id === 'overview' ? null : id });
  const live = useQuery({
    queryKey: ['robot', robot.robot_id, 'live'],
    queryFn: () => api.get<LiveStateDto>(`/robots/${robot.robot_id}/live`),
    refetchInterval: 30_000,
  });
  const name = robot.robot_id.toUpperCase();

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <BesideBack
          above={
            <nav aria-label="Breadcrumb" className="text-sm text-muted">
              <Link href="/robots" className="hover:underline">
                Robots
              </Link>{' '}
              / <span aria-current="page">{name}</span>
            </nav>
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold">{name}</h1>
            <RobotStatusBadge lastSeenAt={robot.last_seen_at} showAge />
          </div>
        </BesideBack>
        {/* The four things people check first, as large tiles. */}
        {/* The four things people check first, on the brand band. */}
        <Band label={`${name} summary`}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:p-6 lg:grid-cols-4">
            <BandFact label="Model">{robot.product_name}</BandFact>
            <div className="min-w-0">
              <dt className="text-base text-muted">Battery</dt>
              <dd className="mt-2">
                <BandMeter pct={live.data?.battery.pct ?? robot.battery_pct} />
              </dd>
            </div>
            <BandFact label="Last seen">{robot.last_seen_at ? fmtRelative(robot.last_seen_at) : 'Never'}</BandFact>
            <BandFact label="Current mission">{robot.current_mission_id ? (robot.current_mission_name ?? robot.current_mission_id) : 'None'}</BandFact>
          </dl>
        </Band>
      </header>

      <div>
        <Tabs label="Robot sections" items={tabs.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={go} />
        <TabPanel id={tab}>
          {tab === 'overview' && (
            <div className="flex flex-col gap-5">
              {location && (
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
              )}
              {has(CLIENT_FEATURES.missionsView) && <RobotMissionsOverview robotId={robot.robot_id} onAllMissions={() => go('missions')} />}
              {!location && !has(CLIENT_FEATURES.missionsView) && !(has(CLIENT_FEATURES.softwareView) && robotSoftware.length > 0) && (
                <EmptyState title="Nothing more to show here yet" description="Location, missions and software appear here once they are turned on for your account. Ask your Arnobot contact if you need them." />
              )}
              {has(CLIENT_FEATURES.softwareView) && robotSoftware.length > 0 && (
                <Card title="Software on this robot" bodyClassName="p-0">
                  <SoftwareTable items={robotSoftware} showRobot={false} />
                </Card>
              )}
            </div>
          )}
          {tab === 'missions' && <RobotMissionsTab robotId={robot.robot_id} />}
          {tab === 'reports' && <RobotReportsTab robot={robot} />}
          {tab === 'detections' && <DetectionsTab robotId={robot.robot_id} audience="client" />}
          {tab === 'telemetry' && <RobotTelemetryTab robotId={robot.robot_id} showTrack={location} />}
          {tab === 'events' && <ClientEvents robotId={robot.robot_id} />}
        </TabPanel>
      </div>
    </div>
  );
}
