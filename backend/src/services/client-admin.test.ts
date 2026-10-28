import type { ClientFeatureDto } from '../shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors';
import { checkFeatureSet, effectiveFeatures, licenceState } from './client-admin';

const f = (key: string, over: Partial<ClientFeatureDto> = {}): ClientFeatureDto => ({
  key,
  area: 'A',
  name: key,
  description: '',
  kind: 'view',
  always_on: false,
  is_default: true,
  requires: [],
  sort_order: 0,
  ...over,
});
const catalogue = [
  f('portal.robots.view', { always_on: true }),
  f('portal.missions.view'),
  f('portal.reports.view', { requires: ['portal.missions.view'] }),
  f('portal.reports.download', { kind: 'export', requires: ['portal.reports.view'] }),
  f('portal.events.view'),
];

describe('checkFeatureSet', () => {
  it('drops always-on keys (they are implied) and sorts', () => {
    expect(checkFeatureSet(catalogue, ['portal.events.view', 'portal.robots.view', 'portal.missions.view'])).toEqual(['portal.events.view', 'portal.missions.view']);
  });
  it('refuses unknown keys', () => {
    expect(() => checkFeatureSet(catalogue, ['portal.recordings.view'])).toThrow(ApiError);
  });
  it('refuses a feature without the ones it requires', () => {
    expect(() => checkFeatureSet(catalogue, ['portal.reports.view'])).toThrow(/needs/);
    expect(() => checkFeatureSet(catalogue, ['portal.reports.download', 'portal.reports.view'])).toThrow(/needs/);
    expect(checkFeatureSet(catalogue, ['portal.reports.download', 'portal.reports.view', 'portal.missions.view'])).toHaveLength(3);
  });
  it("keeps a user inside the organization's set", () => {
    const org = new Set(['portal.missions.view']);
    expect(checkFeatureSet(catalogue, ['portal.missions.view'], org)).toEqual(['portal.missions.view']);
    expect(() => checkFeatureSet(catalogue, ['portal.events.view'], org)).toThrow(/not available/);
  });
});

describe('effectiveFeatures', () => {
  it("is (own ∩ organization's) ∪ always-on", () => {
    expect(effectiveFeatures(catalogue, ['portal.missions.view', 'portal.events.view'], ['portal.missions.view'])).toEqual(['portal.robots.view', 'portal.missions.view']);
    expect(effectiveFeatures(catalogue, [], [])).toEqual(['portal.robots.view']);
  });
});

describe('licenceState', () => {
  const today = new Date('2026-10-15T10:00:00Z');
  it('none / expired / expiring within 30 days / valid', () => {
    expect(licenceState(null, today)).toBe('none');
    expect(licenceState('2026-10-14', today)).toBe('expired');
    expect(licenceState('2026-10-15', today)).toBe('expiring');
    expect(licenceState('2026-11-14', today)).toBe('expiring');
    expect(licenceState('2026-11-15', today)).toBe('valid');
  });
});
