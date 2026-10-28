'use client';

import type { ClientFeatureDto, Paginated, RobotListItemDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { Checkbox } from '@/components/ui/field';
import { LoadingBlock } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * What a colleague gets in the portal (0021): which robots (all of the organization's, now and later, or chosen ones)
 * and which features (at most the organization's). The API checks both again; this only shapes the choice.
 */
export interface AccessChoice {
  robots: 'all' | string[];
  features: string[];
}

export function useFeatureCatalogue() {
  return useQuery({ queryKey: ['client-features'], queryFn: () => api.get<ClientFeatureDto[]>('/client-features'), staleTime: 10 * 60_000 });
}

export function useRobotOptions() {
  return useQuery({ queryKey: ['robots', 'options'], queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }), staleTime: 60_000 });
}

/** Ticking a feature also ticks what it requires; unticking one also unticks what depends on it. */
export function toggleFeature(catalogue: ClientFeatureDto[], selected: string[], key: string, on: boolean): string[] {
  const set = new Set(selected);
  const byKey = new Map(catalogue.map((f) => [f.key, f]));
  if (on) {
    const add = (k: string) => {
      if (set.has(k)) return;
      set.add(k);
      for (const r of byKey.get(k)?.requires ?? []) add(r);
    };
    add(key);
  } else {
    const drop = (k: string) => {
      set.delete(k);
      for (const f of catalogue) if (set.has(f.key) && f.requires.includes(k)) drop(f.key);
    };
    drop(key);
  }
  return catalogue.filter((f) => set.has(f.key) && !f.always_on).map((f) => f.key);
}

export function AccessEditor({ value, onChange, organizationFeatures }: { value: AccessChoice; onChange: (v: AccessChoice) => void; organizationFeatures: string[] }) {
  const catalogue = useFeatureCatalogue();
  const robots = useRobotOptions();
  if (catalogue.isLoading || robots.isLoading) return <LoadingBlock rows={4} label="Loading" />;
  const allowed = new Set(organizationFeatures);
  const features = (catalogue.data ?? []).filter((f) => f.always_on || allowed.has(f.key));
  const areas = [...new Set(features.map((f) => f.area))];
  const robotList = (robots.data?.items ?? []).filter((r) => !r.deleted_at);
  const chosen = value.robots === 'all' ? null : new Set(value.robots);
  const sameAsOrg = features.filter((f) => !f.always_on).every((f) => value.features.includes(f.key));

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Robots</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="robots" checked={value.robots === 'all'} onChange={() => onChange({ ...value, robots: 'all' })} />
          All robots of the organization, including ones added later
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="robots" checked={value.robots !== 'all'} onChange={() => onChange({ ...value, robots: robotList.slice(0, 1).map((r) => r.robot_id) })} />
          Only these robots
        </label>
        {chosen && (
          <div className="ml-6 grid gap-1.5 sm:grid-cols-2">
            {robotList.length === 0 && <p className="text-sm text-muted">Your organization has no robots yet.</p>}
            {robotList.map((r) => (
              <Checkbox
                key={r.robot_id}
                label={
                  <span>
                    <span className="font-mono font-semibold">{r.robot_id.toUpperCase()}</span> <span className="text-muted">· {r.product_name}</span>
                  </span>
                }
                checked={chosen.has(r.robot_id)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(r.robot_id);
                  else next.delete(r.robot_id);
                  onChange({ ...value, robots: [...next].sort() });
                }}
              />
            ))}
            {chosen.size === 0 && <p className="text-xs text-fault sm:col-span-2">Choose at least one robot.</p>}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <legend className="text-sm font-semibold">Features</legend>
          <button
            type="button"
            className="text-xs font-medium text-accent-text hover:underline disabled:text-muted disabled:no-underline"
            disabled={sameAsOrg}
            onClick={() => onChange({ ...value, features: features.filter((f) => !f.always_on).map((f) => f.key) })}
          >
            Same as organization
          </button>
        </div>
        {areas.map((area) => (
          <div key={area}>
            <p className="mb-1 text-sm font-semibold text-muted">{area}</p>
            <div className="flex flex-col gap-1.5">
              {features
                .filter((f) => f.area === area)
                .map((f) =>
                  f.always_on ? (
                    <div key={f.key} className="flex items-start gap-2 text-sm text-muted">
                      <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>
                        <span className="font-medium text-fg">{f.name}</span> · always included
                      </span>
                    </div>
                  ) : (
                    <Checkbox
                      key={f.key}
                      checked={value.features.includes(f.key)}
                      onChange={(e) => onChange({ ...value, features: toggleFeature(catalogue.data!, value.features, f.key, e.target.checked) })}
                      label={
                        <span className="flex flex-col">
                          <span className={cn('font-medium', f.kind === 'export' && 'inline-flex items-center gap-1.5')}>
                            {f.name}
                            {f.kind === 'export' && <span className="rounded bg-surface-2 px-1 text-sm font-semibold text-muted">download</span>}
                          </span>
                          <span className="text-xs text-muted">{f.description}</span>
                        </span>
                      }
                    />
                  ),
                )}
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}

/** Feature names a user ends up with: (chosen ∩ organization) ∪ always-on, in catalogue order. */
export function effectiveNames(catalogue: ClientFeatureDto[] | undefined, chosen: string[], organizationFeatures: string[]): string[] {
  const org = new Set(organizationFeatures);
  return (catalogue ?? []).filter((f) => f.always_on || (chosen.includes(f.key) && org.has(f.key))).map((f) => f.name);
}

export const accessValid = (v: AccessChoice) => v.robots === 'all' || v.robots.length > 0;
