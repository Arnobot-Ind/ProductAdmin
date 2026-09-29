'use client';

import type { AccessModelDto, RoleDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { Badge, Card, InlineAlert, PageHeader, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDocumentTitle } from '@/lib/hooks';

/** Permission groups, in the order people ask about them. Unknown keys fall into "Other". */
const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'View', keys: ['robot.read', 'data.sensors', 'catalog.read', 'credential.read_meta', 'ingest.read', 'system.read', 'audit.read'] },
  { title: 'Download', keys: ['data.download', 'data.download_restricted', 'credential.reveal'] },
  { title: 'Control', keys: ['robot.control', 'event.ack'] },
  { title: 'Delete', keys: ['data.delete', 'robot.delete'] },
  {
    title: 'Manage',
    keys: ['robot.write', 'ownership.write', 'hardware.write', 'maintenance.write', 'document.write', 'credential.write', 'ingest.manage', 'catalog.write', 'release.write', 'org.manage', 'user.manage'],
  },
];

/** Plain-language names for the matrix (the key is shown too). */
const LABEL: Record<string, string> = {
  'robot.read': 'View robots and recordings (video)',
  'data.sensors': 'See LiDAR / IMU data',
  'data.download': 'Download video & metadata',
  'data.download_restricted': 'Download raw LiDAR / IMU',
  'data.delete': 'Delete recordings',
  'robot.control': 'Control robots',
  'event.ack': 'Acknowledge events',
  'robot.delete': 'Delete robots',
  'robot.write': 'Register & edit robots',
  'ownership.write': 'Assign robots to organizations',
  'hardware.write': 'Fit / remove hardware',
  'maintenance.write': 'Record repairs',
  'document.write': 'Upload documents',
  'credential.read_meta': 'See device credentials exist',
  'credential.reveal': 'Reveal device credentials',
  'credential.write': 'Manage device credentials',
  'ingest.read': 'View ingest log',
  'ingest.manage': 'Manage robot ingest keys',
  'catalog.read': 'View product catalogue',
  'catalog.write': 'Edit product catalogue',
  'release.write': 'Register releases',
  'org.manage': 'Manage organizations',
  'user.manage': 'Manage users & roles',
  'audit.read': 'Read the audit log',
  'system.read': 'Server & storage status',
};

export default function AccessPage() {
  useDocumentTitle('Roles & permissions');
  const me = useMe();
  const q = useQuery({ queryKey: ['access-model'], queryFn: () => api.get<AccessModelDto>('/access-model'), staleTime: 300_000 });
  const mine = new Set(me.grants.map((g) => g.role_key));
  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Roles & permissions"
        description="What each role can see and do. Admin is for Arnobot. Manager and Viewer can be given to Arnobot staff (all robots) or to a customer organization's users (only that organization's robots)."
      />
      <QueryView query={q} rows={10}>
        {(model) => {
          const staff = model.roles.filter((r) => r.audience === 'staff');
          const customer = model.roles.filter((r) => r.audience !== 'staff');
          const roles = [...staff, ...customer];
          const known = new Set(GROUPS.flatMap((g) => g.keys));
          const groups = [...GROUPS, { title: 'Other', keys: model.permissions.map((p) => p.key).filter((k) => !known.has(k)) }].filter((g) => g.keys.length);
          const desc = new Map(model.permissions.map((p) => [p.key, p.description]));
          return (
            <div className="flex flex-col gap-6">
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">Permission matrix: which role holds which permission</caption>
                  <thead className="bg-surface-2">
                    <tr>
                      <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 py-2 text-left font-semibold">
                        Permission
                      </th>
                      <th colSpan={staff.length} scope="colgroup" className="border-l border-border px-3 pt-2 text-center text-xs font-semibold tracking-wide text-muted uppercase">
                        Arnobot only
                      </th>
                      <th colSpan={customer.length} scope="colgroup" className="border-l border-border px-3 pt-2 text-center text-xs font-semibold tracking-wide text-muted uppercase">
                        Arnobot or customer
                      </th>
                    </tr>
                    <tr>
                      <th className="sticky left-0 z-10 bg-surface-2" aria-hidden />
                      {roles.map((r, i) => (
                        <th key={r.key} scope="col" className={cn('px-3 pb-2 text-center text-xs font-semibold whitespace-nowrap', (i === 0 || i === staff.length) && 'border-l border-border')}>
                          {r.name}
                          {mine.has(r.key) && (
                            <Badge tone="accent" className="ml-1">
                              You
                            </Badge>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {groups.map((g) => (
                    <tbody key={g.title}>
                      <tr className="border-t border-border bg-surface-2/50">
                        <th scope="rowgroup" colSpan={roles.length + 1} className="sticky left-0 px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                          {g.title}
                        </th>
                      </tr>
                      {g.keys
                        .filter((k) => desc.has(k))
                        .map((k) => (
                          <tr key={k} className="border-t border-border">
                            <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-normal" title={desc.get(k)}>
                              <span className="block font-medium">{LABEL[k] ?? k}</span>
                              <code className="font-mono text-xs text-muted">{k}</code>
                            </th>
                            {roles.map((r, i) => (
                              <td key={r.key} className={cn('px-3 py-2 text-center', (i === 0 || i === staff.length) && 'border-l border-border')}>
                                {r.permissions.includes(k) ? (
                                  <Check className="mx-auto size-4 text-ok" aria-label={`${r.name}: yes`} />
                                ) : (
                                  <Minus className="mx-auto size-4 text-border" aria-label={`${r.name}: no`} />
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  ))}
                </table>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <RoleCards title="Arnobot only" roles={staff} />
                <RoleCards title="Arnobot or customer organization" roles={customer} />
              </div>

              <InlineAlert tone="accent" title="Rules the PMS always applies">
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>Customer users see only robots currently assigned to their organization, and never data recorded while another customer owned the robot.</li>
                  <li>Viewing a recording streams it; downloading is a separate permission. LiDAR and IMU data is shown only to Admins; customers never see it.</li>
                  <li>Robot and device credentials (SSH, Wi-Fi, camera passwords, ingest keys) are separate from user logins and never visible to customer roles.</li>
                  <li>Only a super-admin can give Arnobot-wide (platform) roles. Customer users can only be given access inside their own organization.</li>
                  <li>Sign-ins, recording views, downloads, robot assignments, permission changes and refused requests are written to the audit log.</li>
                </ul>
              </InlineAlert>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

function RoleCards({ title, roles }: { title: string; roles: RoleDto[] }) {
  return (
    <Card title={title}>
      <ul className="flex flex-col gap-3">
        {roles.map((r) => (
          <li key={r.key}>
            <p className="font-semibold">{r.name}</p>
            {r.description && <p className="text-sm text-muted">{r.description}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
