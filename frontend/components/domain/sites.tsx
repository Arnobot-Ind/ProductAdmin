'use client';

import { fmtSerial, fmtSiteNo } from '@/lib/format';
import type { RobotDeploymentDto, SiteDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { RobotPicker } from '@/components/domain/robot-picker';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { useCompanies } from '@/lib/queries';

export function useSites(includeDeleted = false) {
  return useQuery({ queryKey: ['sites', { includeDeleted }], queryFn: () => api.get<SiteDto[]>('/sites', { include_deleted: includeDeleted }), staleTime: 120_000 });
}

/** "Khavda, Gujarat": where a site is, in a few words. */
export const sitePlace = (s: Pick<SiteDto, 'city' | 'state' | 'country'>) => [s.city, s.state].filter(Boolean).join(', ') || s.country || '';

/** Opens the site's position (or its address) in Google Maps. */
export function MapLink({ site, className }: { site: Pick<SiteDto, 'latitude' | 'longitude' | 'address' | 'city' | 'state' | 'name'>; className?: string }) {
  const q = site.latitude !== null && site.longitude !== null ? `${site.latitude},${site.longitude}` : [site.name, site.address, site.city, site.state].filter(Boolean).join(', ');
  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? 'inline-flex items-center gap-1 text-accent-text hover:underline'}
      onClick={(e) => e.stopPropagation()}
    >
      Open in Google Maps <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

const EMPTY = { name: '', company_id: '', address: '', city: '', state: '', country: 'India', latitude: '', longitude: '', contact_name: '', contact_phone: '', contact_email: '', notes: '' };

/** Add a site, or edit one: name, whose site, address, map position and the contact person there. */
export function SiteDialog({ value, onClose, onSaved }: { value: SiteDto | null; onClose: () => void; onSaved?: (s: SiteDto) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const companies = useCompanies();
  const [f, setF] = useState(() =>
    value ? Object.fromEntries(Object.keys(EMPTY).map((k) => [k, value[k as keyof SiteDto] == null ? '' : String(value[k as keyof SiteDto])])) as typeof EMPTY : EMPTY,
  );
  // Every site belongs to an organization; a new one starts with Arnobot.
  const internalId = companies.data?.find((c) => c.kind === 'internal')?.id ?? '';
  const companyId = f.company_id || (value ? '' : internalId);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lat = f.latitude.trim() ? Number(f.latitude) : null;
  const lng = f.longitude.trim() ? Number(f.longitude) : null;
  const posBad = (lat === null) !== (lng === null) || (lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90)) || (lng !== null && (Number.isNaN(lng) || lng < -180 || lng > 180));
  const m = useMutation({
    mutationFn: () => {
      const t = (k: keyof typeof EMPTY) => f[k].trim() || null;
      const body = {
        name: f.name.trim(),
        company_id: companyId,
        address: t('address'),
        city: t('city'),
        state: t('state'),
        country: t('country'),
        latitude: lat,
        longitude: lng,
        contact_name: t('contact_name'),
        contact_phone: t('contact_phone'),
        contact_email: t('contact_email'),
        notes: t('notes'),
      };
      return value ? api.patch<SiteDto>(`/sites/${value.id}`, body) : api.post<SiteDto>('/sites', body);
    },
    onSuccess: (s) => {
      toast.success(value ? `${s.name} saved` : `${s.name} added`);
      void qc.invalidateQueries({ queryKey: ['sites'] });
      void qc.invalidateQueries({ queryKey: ['site', s.id] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
      onSaved?.(s);
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={value ? `Edit ${value.name}` : 'Add site'}
      description="A place robots are deployed to. Robots show their site wherever they are listed."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!f.name.trim() || !companyId || posBad}>
            {value ? 'Save' : 'Add site'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Site name" required>
          <Input value={f.name} onChange={set('name')} maxLength={120} placeholder="e.g. Khavda Solar Park, Block 4" data-autofocus />
        </Field>
        <Field label="Whose site" required hint="Usually the customer's organization">
          <Select value={companyId} onChange={set('company_id')}>
            {(companies.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Textarea rows={2} value={f.address} onChange={set('address')} maxLength={500} />
        </Field>
        <Field label="City / town">
          <Input value={f.city} onChange={set('city')} maxLength={100} />
        </Field>
        <Field label="State">
          <Input value={f.state} onChange={set('state')} maxLength={100} />
        </Field>
        <Field label="Country">
          <Input value={f.country} onChange={set('country')} maxLength={100} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude" error={posBad ? 'Both, as numbers' : null}>
            <Input inputMode="decimal" value={f.latitude} onChange={set('latitude')} placeholder="23.9" />
          </Field>
          <Field label="Longitude">
            <Input inputMode="decimal" value={f.longitude} onChange={set('longitude')} placeholder="69.6" />
          </Field>
        </div>
        <Field label="Contact person on site">
          <Input value={f.contact_name} onChange={set('contact_name')} maxLength={120} />
        </Field>
        <Field label="Contact phone">
          <Input type="tel" value={f.contact_phone} onChange={set('contact_phone')} maxLength={40} />
        </Field>
        <Field label="Contact email">
          <Input type="email" value={f.contact_email} onChange={set('contact_email')} maxLength={200} />
        </Field>
        <Field label="Notes" hint="Access rules, gate pass, working hours …" className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={set('notes')} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Deploy a robot at a site: which site (from a robot's page) or which robot (from a site's page), from when, and
 * what it does there. A deployment elsewhere ends at the same moment.
 */
export function DeployDialog({
  robotId,
  current,
  site,
  onClose,
  onDone,
}: {
  /** From a robot's page. */
  robotId?: string;
  /** The robot's current deployment, if any (it ends when this one starts). */
  current?: RobotDeploymentDto | null;
  /** From a site's page. */
  site?: SiteDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const sites = useSites();
  const [siteId, setSiteId] = useState(site?.id ?? '');
  const [robot, setRobot] = useState(robotId ?? '');
  const [when, setWhen] = useState(toLocalInput(new Date().toISOString()));
  const [purpose, setPurpose] = useState('');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const options = (sites.data ?? []).filter((s) => s.id !== current?.site_id);
  const m = useMutation({
    mutationFn: () => api.post<RobotDeploymentDto>(`/robots/${robot}/deployments`, { site_id: siteId, deployed_at: fromLocalInput(when), purpose: purpose.trim() || null, notes: notes.trim() || null }),
    onSuccess: (d) => {
      toast.success(`${fmtSerial(d.robot_id)} deployed at ${d.site_name}`);
      onDone();
      onClose();
    },
    onError: toast.error,
  });
  return (
    <>
      <Dialog
        open={!adding}
        onClose={onClose}
        title={robotId ? (current ? `Move ${fmtSerial(robotId)} to another site` : `Deploy ${fmtSerial(robotId)}`) : `Deploy a robot at ${site?.name}`}
        description={current ? `${fmtSerial(robotId)} is at ${current.site_name} now; that deployment ends when this one starts.` : undefined}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!siteId || !robot}>
              Deploy
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {robotId ? (
            <Field label="Site" required hint={sites.data && !options.length ? 'No other sites yet: add one.' : undefined}>
              <div className="flex gap-2">
                <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} data-autofocus>
                  <option value="">Choose…</option>
                  {options.map((s) => (
                    <option key={s.id} value={s.id}>
                      {fmtSiteNo(s.org_no, s.site_no)} · {s.name}
                      {sitePlace(s) ? ` · ${sitePlace(s)}` : ''}
                      {s.company_name ? ` (${s.company_name})` : ''}
                    </option>
                  ))}
                </Select>
                <Button onClick={() => setAdding(true)}>New site</Button>
              </div>
            </Field>
          ) : (
            <Field label="Robot" required>
              <RobotPicker value={robot} autoFocus onChange={(id) => setRobot(id)} />
            </Field>
          )}
          <Field label="Deployed on">
            <Input type="datetime-local" value={when} max={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field label="What it does there" hint="Optional, e.g. Night patrol of blocks 3–5">
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Note (optional)">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
          </Field>
        </div>
      </Dialog>
      {adding && <SiteDialog value={null} onClose={() => setAdding(false)} onSaved={(s) => setSiteId(s.id)} />}
    </>
  );
}
