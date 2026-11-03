'use client';

import type { SiteDto } from '@arnobot/message-schema';
import { MapPinned, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MapLink, SiteDialog, sitePlace, useSites } from '@/components/domain/sites';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/field';
import { Badge, EmptyState, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';
import { fmtSiteNo } from '@/lib/format';

/** Every site robots are deployed to: where it is, whose it is, who to call, and how many robots are there now. */
export default function SitesPage() {
  useDocumentTitle('Sites');
  const can = useCan();
  const router = useRouter();
  const [showRetired, setShowRetired] = useState(false);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useSites(showRetired);
  const term = search.trim().toLowerCase();
  const match = (s: SiteDto) => !term || [s.name, s.city, s.state, s.address, s.company_name, s.contact_name, fmtSiteNo(s.org_no, s.site_no)].some((v) => v?.toLowerCase().includes(term));

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Sites"
        description="The places robots are deployed to. Deploy a robot from its page (Records → Deployment) or from a site here."
        actions={
          can('robot.write') ? (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
              Add site
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="relative min-w-0 flex-1 basis-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search site, city, organization or contact" aria-label="Search sites" className="pl-9" />
        </span>
        <Checkbox label="Show retired" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
      </div>
      <QueryView query={q}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={<MapPinned className="size-8" />}
              title="No sites yet"
              description="Add the places your robots work at: a solar park, a plant, a campus. Then deploy robots there."
              action={can('robot.write') ? <Button variant="primary" onClick={() => setAdding(true)}>Add site</Button> : undefined}
            />
          ) : (
            <DataTable
              caption="Sites"
              compact
              rows={list.filter(match)}
              rowKey={(s) => s.id}
              onRowClick={(s) => router.push(`/sites/${s.id}`)}
              rowClassName={(s) => (s.deleted_at ? 'opacity-60' : undefined)}
              empty={`No site matches “${search}”.`}
              columns={[
                {
                  key: 'name',
                  header: 'Site',
                  rowHeader: true,
                  cell: (s) => (
                    <span className="block max-w-80 min-w-48">
                      <Link href={`/sites/${s.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-accent-text hover:underline">
                        {s.name}
                      </Link>
                      <span className="ml-2 font-mono text-sm text-muted">{fmtSiteNo(s.org_no, s.site_no)}</span>
                      {s.deleted_at && (
                        <>
                          {' '}
                          <Badge tone="fault">Retired</Badge>
                        </>
                      )}
                      {sitePlace(s) && <span className="block text-sm text-muted">{sitePlace(s)}</span>}
                    </span>
                  ),
                },
                { key: 'org', header: 'Whose site', cell: (s) => s.company_name ?? <span className="text-muted">—</span> },
                {
                  key: 'now',
                  header: 'Robots now',
                  align: 'right',
                  cell: (s) =>
                    s.robots_now ? (
                      <Link href={`/robots?site=${s.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-accent-text hover:underline">
                        {s.robots_now}
                      </Link>
                    ) : (
                      <span className="text-muted">0</span>
                    ),
                },
                { key: 'ever', header: 'Ever', align: 'right', className: 'hidden sm:table-cell', cell: (s) => <span className="tabular-nums">{s.robots_ever}</span> },
                {
                  key: 'contact',
                  header: 'Contact on site',
                  className: 'hidden md:table-cell',
                  cell: (s) =>
                    s.contact_name || s.contact_phone ? (
                      <span className="block">
                        {s.contact_name}
                        {s.contact_phone && <span className="block text-sm text-muted">{s.contact_phone}</span>}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    ),
                },
                { key: 'map', header: 'Map', className: 'hidden lg:table-cell whitespace-nowrap', cell: (s) => <MapLink site={s} /> },
              ]}
            />
          )
        }
      </QueryView>
      {adding && <SiteDialog value={null} onClose={() => setAdding(false)} onSaved={(s) => router.push(`/sites/${s.id}`)} />}
    </>
  );
}
