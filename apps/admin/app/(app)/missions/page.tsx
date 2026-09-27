'use client';

import { MissionsTable, type MissionFilters } from '@/components/domain/missions-table';
import { PageHeader } from '@/components/ui/misc';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';

export default function MissionsPage() {
  useDocumentTitle('Missions');
  const [params, setParams] = useUrlState();
  const filters: MissionFilters = {
    robot: params.get('robot') ?? undefined,
    result: params.get('result') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    page: Number(params.get('page') ?? 1) || 1,
  };
  return (
    <>
      <PageHeader eyebrow="Fleet" title="Missions" description="Every mission belongs to one robot. Open a mission to see its planned and actual paths and its files." />
      <MissionsTable
        filters={filters}
        onFilters={(p) =>
          setParams(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === undefined ? null : k === 'page' && v === 1 ? null : String(v)])))
        }
      />
    </>
  );
}
