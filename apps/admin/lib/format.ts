/**
 * Display formatting. Times: stored/sent as UTC, SHOWN in the user's local zone, UTC on hover.
 * Units are always shown (m, km, m/s, °C, %, V, dBm).
 */

const dtf = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' });

export const DASH = '—';

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : dtf.format(d);
}

/** For `title=` tooltips: exact UTC value. */
export function fmtUtc(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${d.toISOString().replace('T', ' ').replace('.000Z', 'Z')} (UTC)`;
}

/** Calendar dates ('YYYY-MM-DD') are not instants; format without timezone shifting. */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return dateOnly.format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? DASH : dateOnly.format(d);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return DASH;
  const s = Math.round((t - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return rtf.format(s, 'second');
  if (a < 2700) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 64800) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 2592000) return rtf.format(Math.round(s / 86400), 'day');
  return fmtDateTime(iso);
}

/** 4320 → "1h 12m"; 45 → "45s". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Metres → "850 m" / "12.4 km". */
export function fmtDistance(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return DASH;
  if (Math.abs(m) >= 1000) return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km`;
  return `${Math.round(m).toLocaleString()} m`;
}

export function fmtNum(v: number | null | undefined, unit = '', digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  const n = v.toLocaleString(undefined, { maximumFractionDigits: digits });
  return unit ? `${n} ${unit}` : n;
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? DASH : `${Math.round(v)} %`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

export function fmtCoord(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return DASH;
  return `${lat.toFixed(6)}°, ${lon.toFixed(6)}°`;
}

/** snake_case → "Snake case" for enum labels. */
export function humanize(v: string | null | undefined): string {
  if (!v) return DASH;
  const s = v.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** ISO → value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function todayDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
