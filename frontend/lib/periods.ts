/**
 * Time periods people pick on the dashboard and the Missions page. Days are IST days; "now" moves on, so the
 * bounds are computed when a period is picked (and refreshed by the page).
 */
export const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '1 month' },
  { id: '90d', label: '3 months' },
  { id: 'all', label: 'All time' },
] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];

/** IST calendar day `daysAgo` days back, YYYY-MM-DD. */
export const istDayAgo = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istMidnight = (day: string) => `${day}T00:00:00+05:30`;

/** The period as ISO bounds [from, to); `all` has none. */
export function periodBounds(p: PeriodId, now = Date.now()): { from?: string; to?: string } {
  switch (p) {
    case 'today':
      return { from: istMidnight(istDayAgo(0)), to: new Date(now).toISOString() };
    case 'yesterday':
      return { from: istMidnight(istDayAgo(1)), to: istMidnight(istDayAgo(0)) };
    case '24h':
      return { from: new Date(Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000).toISOString(), to: new Date(now).toISOString() };
    case '7d':
      return { from: istMidnight(istDayAgo(6)), to: new Date(now).toISOString() };
    case '30d':
      return { from: istMidnight(istDayAgo(29)), to: new Date(now).toISOString() };
    case '90d':
      return { from: istMidnight(istDayAgo(89)), to: new Date(now).toISOString() };
    case 'all':
      return {};
  }
}

/** Periods short enough to show per hour. */
export const isHourly = (p: PeriodId) => p === 'today' || p === 'yesterday' || p === '24h';
/** Days covered by a daily period (for the fleet report). */
export const periodDays = (p: PeriodId) => (p === '7d' ? 7 : p === '90d' ? 90 : 30);
