'use client';

import type { ClientFeatureDto, ClientStatus, LicenceState, OrganizationDetailDto, UserAccessDto, UserDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { Badge, InlineAlert, QueryView, type Tone } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';

/**
 * Client admin (0021): what a customer organization and each of its users may use in the client app.
 * The API is the source of truth; these helpers only mirror its rules (always-on, `requires`) for the UI.
 */

export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = { onboarding: 'Onboarding', active: 'Active', suspended: 'Suspended', ended: 'Ended' };
const CLIENT_STATUS_TONE: Record<ClientStatus, Tone> = { onboarding: 'accent', active: 'ok', suspended: 'warn', ended: 'offline' };

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  return <Badge tone={CLIENT_STATUS_TONE[status]}>{CLIENT_STATUS_LABEL[status]}</Badge>;
}

const LICENCE: Record<LicenceState, { tone: Tone; label: string }> = {
  none: { tone: 'neutral', label: 'No licence' },
  valid: { tone: 'ok', label: 'Valid' },
  expiring: { tone: 'warn', label: 'Expiring' },
  expired: { tone: 'fault', label: 'Expired' },
};

export function LicenceBadge({ state, until }: { state: LicenceState; until: string | null }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={LICENCE[state].tone}>{LICENCE[state].label}</Badge>
      {until && <span className="text-xs text-muted">until {fmtDate(until)}</span>}
    </span>
  );
}

export function useClientFeatures(enabled = true) {
  return useQuery({ queryKey: ['client-features'], queryFn: () => api.get<ClientFeatureDto[]>('/client-features'), staleTime: 300_000, enabled });
}

/** Adds `key` and everything it requires (transitively). */
function withRequired(catalogue: ClientFeatureDto[], set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  const add = (k: string) => {
    if (next.has(k)) return;
    next.add(k);
    for (const r of catalogue.find((f) => f.key === k)?.requires ?? []) add(r);
  };
  add(key);
  return next;
}

/** Removes `key` and everything that requires it (transitively). */
function withoutDependents(catalogue: ClientFeatureDto[], set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  const drop = (k: string) => {
    if (!next.delete(k)) return;
    for (const f of catalogue) if (f.requires.includes(k)) drop(f.key);
  };
  drop(key);
  return next;
}

/**
 * Feature checklist grouped by area. Always-on features are shown ticked and locked; ticking a feature ticks what it
 * requires, unticking one unticks what depends on it. `available` limits the choice (a user: the organization's set).
 */
export function FeatureChecklist({
  catalogue,
  value,
  onChange,
  available,
  disabled,
}: {
  catalogue: ClientFeatureDto[];
  value: string[];
  onChange: (keys: string[]) => void;
  available?: string[];
  disabled?: boolean;
}) {
  const set = new Set(value);
  const areas = [...new Set(catalogue.map((f) => f.area))];
  const toggle = (f: ClientFeatureDto, on: boolean) => onChange([...(on ? withRequired(catalogue, set, f.key) : withoutDependents(catalogue, set, f.key))].sort());
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {areas.map((area) => (
        <fieldset key={area} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-semibold text-muted">{area}</legend>
          {catalogue
            .filter((f) => f.area === area)
            .map((f) => {
              const locked = f.always_on;
              const unavailable = !locked && !!available && !available.includes(f.key);
              const missing = f.requires.filter((r) => available && !available.includes(r) && !catalogue.find((c) => c.key === r)?.always_on);
              return (
                <label key={f.key} className={`flex items-start gap-2 text-sm ${unavailable ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--accent)]"
                    checked={locked || set.has(f.key)}
                    disabled={disabled || locked || unavailable || missing.length > 0}
                    onChange={(e) => toggle(f, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      {f.name}
                      <Badge tone={f.kind === 'export' ? 'accent' : 'neutral'}>{f.kind}</Badge>
                      {locked && (
                        <Badge icon={<Lock className="size-3" aria-hidden />} title="Everyone has it">
                          always on
                        </Badge>
                      )}
                    </span>
                    <span className="block text-xs text-muted">
                      {f.description}
                      {f.requires.length > 0 && ` · needs ${f.requires.map((r) => catalogue.find((c) => c.key === r)?.name ?? r).join(', ')}`}
                      {unavailable && ' · not available to this organization'}
                    </span>
                  </span>
                </label>
              );
            })}
        </fieldset>
      ))}
    </div>
  );
}

/** A customer user's role, robots and client-app features (GET / PUT /users/:id/access). */
export function UserAccessDialog({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalogue = useClientFeatures(!!user);
  const access = useQuery({ queryKey: ['users', user?.id, 'access'], queryFn: () => api.get<UserAccessDto>(`/users/${user!.id}/access`), enabled: !!user });
  const org = useQuery({
    queryKey: ['organizations', user?.company_id],
    queryFn: () => api.get<OrganizationDetailDto>(`/organizations/${user!.company_id}`),
    enabled: !!user,
  });
  const [role, setRole] = useState<'manager' | 'viewer'>('viewer');
  const [allRobots, setAllRobots] = useState(true);
  const [robots, setRobots] = useState<string[]>([]);
  const [features, setFeatures] = useState<string[]>([]);
  useEffect(() => {
    const a = access.data;
    if (!a) return;
    setRole(a.role_key === 'manager' ? 'manager' : 'viewer');
    setAllRobots(a.robots === 'all');
    setRobots(a.robots === 'all' ? [] : a.robots);
    setFeatures(a.features);
  }, [access.data]);

  const orgFeatures = org.data?.features ?? [];
  const m = useMutation({
    mutationFn: () => api.put<UserAccessDto>(`/users/${user!.id}/access`, { role_key: role, robots: allRobots ? 'all' : robots, features }),
    onSuccess: () => {
      toast.success(`Access of ${user!.name} updated`);
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
    },
    onError: toast.error,
  });
  // Preview of what the API will compute: (chosen ∩ organization's) ∪ always-on.
  const effective = (catalogue.data ?? []).filter((f) => f.always_on || (features.includes(f.key) && orgFeatures.includes(f.key)));
  const valid = allRobots || robots.length > 0;

  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      size="lg"
      title={`Access of ${user?.name ?? ''}`}
      description={user ? `${user.email} · ${user.company_name}. They see this in the client app; the API enforces it.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!valid || !access.data}>
            Save access
          </Button>
        </>
      }
    >
      <QueryView query={access} rows={6}>
        {() => (
          <div className="flex flex-col gap-5">
            <Field label="Role" hint={role === 'manager' ? 'Manager: also invites and manages users of their own organization.' : 'Viewer: sees what is ticked below.'}>
              <Select value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'viewer')} data-autofocus>
                <option value="viewer">Viewer</option>
                <option value="manager">Manager</option>
              </Select>
            </Field>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Robots</legend>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="robots" className="mt-1" checked={allRobots} onChange={() => setAllRobots(true)} />
                <span>
                  <span className="font-medium">Every robot of {user?.company_name}</span> <span className="text-muted">(now and robots assigned later)</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="robots" className="mt-1" checked={!allRobots} onChange={() => setAllRobots(false)} />
                <span className="font-medium">Only these robots</span>
              </label>
              {!allRobots && (
                <div className="ml-6 flex flex-wrap gap-3">
                  {(org.data?.robots ?? []).length === 0 ? (
                    <p className="text-sm text-muted">The organization has no robots yet.</p>
                  ) : (
                    org.data!.robots.map((r) => (
                      <label key={r.robot_id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--accent)]"
                          checked={robots.includes(r.robot_id)}
                          onChange={(e) => setRobots(e.target.checked ? [...robots, r.robot_id].sort() : robots.filter((x) => x !== r.robot_id))}
                        />
                        <span className="font-mono">{r.robot_id}</span>
                      </label>
                    ))
                  )}
                </div>
              )}
            </fieldset>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Features</p>
                <Button size="sm" onClick={() => setFeatures([...orgFeatures].sort())}>
                  Same as organization
                </Button>
              </div>
              <QueryView query={catalogue} rows={4}>
                {(cat) => <FeatureChecklist catalogue={cat} value={features} onChange={setFeatures} available={orgFeatures} />}
              </QueryView>
            </div>

            <InlineAlert tone="accent" title="They will have">
              {effective.length ? effective.map((f) => f.name).join(', ') : 'Nothing yet.'}
              {allRobots ? ` · on every robot of ${user?.company_name}` : ` · on ${robots.length ? robots.join(', ') : 'no robots'}`}
            </InlineAlert>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}
