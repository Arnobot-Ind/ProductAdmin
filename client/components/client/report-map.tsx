'use client';

/**
 * Read-only route map for the client view, ported from the GCS's ReportMap (gcs_frontend features/reports/ReportMap.tsx)
 * so the patrol track looks the same in both: Leaflet with Google street / Google satellite / Esri satellite tiles and
 * the Map · Google · Esri toggle, the driven path in orange (split at gaps, estimated stretches dashed white as in the
 * PDF), green start / red end dots and a legend. Dark theme uses the same street tiles under the .gcs-tiles-dark filter.
 *
 * Three modes: `points` (a day report's cleaned track), `position` (the robot's current location), or one mission as the
 * GCS Mission Reports map draws it: `waypoints` (dashed planned route, solid green between reached waypoints, numbered
 * markers green = reached / grey = not reached) plus `missionPath` (the actual driven path in orange).
 * Leaflet touches `window`: load this with next/dynamic and ssr: false.
 */
import type { MissionWaypointDto, ReportPathPointDto } from '@arnobot/message-schema';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Map as MapIcon, Satellite } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { useTheme } from '@/lib/theme';

// Tile sources (same as GCS features/map/offlineTiles.ts).
const STREET_URL = 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';
const SATELLITE_URL = 'https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
const GOOGLE_SUBDOMAINS = ['mt0', 'mt1', 'mt2', 'mt3'];
const GOOGLE_MAX_NATIVE_ZOOM = 20;
const ESRI_SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_MAX_NATIVE_ZOOM = 18;
const ESRI_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';

// GCS MAP_COLORS.
const TRACK_COLOR = '#FF9F0A';
const START_COLOR = '#30D158';
const END_COLOR = '#FF453A';
const LIVE_COLOR = '#00b4ff';
const PLANNED_COLOR = '#A7BCE3';
const REACHED_COLOR = '#30D158';
const PENDING_COLOR = '#8E8E93';

const istHm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

function dotIcon(color: string, size = 14) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}"><circle cx="8" cy="8" r="6" fill="${color}" stroke="white" stroke-width="2"/></svg>`;
  return L.divIcon({ html: svg, iconSize: [size, size], iconAnchor: [size / 2, size / 2], className: '' });
}

/** Numbered waypoint marker (GCS wpIcon): green when reached, grey when not. */
function wpIcon(seq: number, reached: boolean) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="26" height="26"><circle cx="12" cy="12" r="12" fill="${reached ? REACHED_COLOR : PENDING_COLOR}" stroke="white" stroke-width="2"/><text x="12" y="17" text-anchor="middle" font-size="10" font-weight="bold" fill="black" font-family="monospace">${seq}</text></svg>`;
  return L.divIcon({ html: svg, iconSize: [26, 26], iconAnchor: [13, 13], className: '' });
}

/** Pan / zoom to fit everything drawn whenever it changes. */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) map.setView(points[0], 17);
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 18 });
  }, [points, map]);
  return null;
}

interface Segment {
  est: boolean;
  pts: [number, number][];
}

/** Splits the track at gaps longer than `breakGapMs` and wherever it switches between measured and estimated. */
function segments(points: ReportPathPointDto[], breakGapMs: number): Segment[] {
  const out: Segment[] = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    const gap = !prev || Date.parse(p.t) - Date.parse(prev.t) > breakGapMs;
    const est = prev ? prev.est || p.est : p.est;
    const last = out[out.length - 1];
    if (gap) out.push({ est: p.est, pts: [[p.lat, p.lon]] });
    else if (last.est !== est) out.push({ est, pts: [[prev.lat, prev.lon], [p.lat, p.lon]] });
    else last.pts.push([p.lat, p.lon]);
  });
  return out.filter((s) => s.pts.length > 1);
}

export interface ReportMapProps {
  points?: ReportPathPointDto[];
  position?: { lat: number; lon: number; label: string } | null;
  breakGapMs?: number;
  height?: string;
  /** One mission's waypoints (planned route + reached state). */
  waypoints?: MissionWaypointDto[];
  /** One mission's driven path, [lat, lon]. */
  missionPath?: [number, number][];
  showMissionPath?: boolean;
}

export function ReportMap({ points = [], position = null, breakGapMs = 30_000, height = '100%', waypoints = [], missionPath = [], showMissionPath = true }: ReportMapProps) {
  const { theme } = useTheme();
  const [mapType, setMapType] = useState<'street' | 'satellite' | 'esri'>('street');
  const isSatellite = mapType !== 'street';
  const isEsri = mapType === 'esri';
  const tileUrl = isEsri ? ESRI_SATELLITE_URL : isSatellite ? SATELLITE_URL : STREET_URL;
  const mapBg = theme === 'light' ? '#e8ecf5' : '#000000';
  const overlayBg = theme === 'light' ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.82)';
  const overlayBdr = theme === 'light' ? '#c8d0e0' : 'rgba(255,255,255,0.12)';

  const track = useMemo(() => points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)), [points]);
  const segs = useMemo(() => segments(track, breakGapMs), [track, breakGapMs]);
  const planned = useMemo(() => waypoints.map((w) => [w.lat, w.lng] as [number, number]), [waypoints]);
  const reachedPts = useMemo(() => waypoints.filter((w) => w.reached).map((w) => [w.lat, w.lng] as [number, number]), [waypoints]);
  const driven = showMissionPath ? missionPath : [];
  const fitPts = useMemo<[number, number][]>(() => {
    const all: [number, number][] = [...track.map((p) => [p.lat, p.lon] as [number, number]), ...planned, ...driven];
    return all.length ? all : position ? [[position.lat, position.lon]] : [];
  }, [track, planned, driven, position]);
  const center: [number, number] = fitPts.length ? fitPts[0] : [22, 78];
  const first = track[0];
  const last = track[track.length - 1];
  const hasEst = segs.some((s) => s.est);

  return (
    <div style={{ height, width: '100%', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
      <MapContainer center={center} zoom={fitPts.length ? 16 : 4} maxZoom={22} scrollWheelZoom attributionControl={false} style={{ width: '100%', height: '100%', background: mapBg }}>
        <TileLayer
          key={`${theme}-${mapType}`}
          url={tileUrl}
          maxNativeZoom={isEsri ? ESRI_MAX_NATIVE_ZOOM : GOOGLE_MAX_NATIVE_ZOOM}
          maxZoom={22}
          className={!isSatellite && theme !== 'light' ? 'gcs-tiles-dark' : undefined}
          subdomains={isEsri ? [] : GOOGLE_SUBDOMAINS}
          crossOrigin="anonymous"
        />
        <FitBounds points={fitPts} />

        {segs.map((s, i) =>
          s.est ? (
            <Polyline key={i} positions={s.pts} pathOptions={{ color: '#ffffff', weight: 3, opacity: 0.95, dashArray: '8 6' }} />
          ) : (
            <Polyline key={i} positions={s.pts} pathOptions={{ color: TRACK_COLOR, weight: 3, opacity: 0.95 }} />
          ),
        )}
        {/* One mission, as the GCS: planned (dashed), reached (solid green), actual path (orange) on top. */}
        {planned.length > 1 && <Polyline positions={planned} pathOptions={{ color: PLANNED_COLOR, weight: 2, dashArray: '6 6', opacity: 0.7 }} />}
        {reachedPts.length > 1 && <Polyline positions={reachedPts} pathOptions={{ color: REACHED_COLOR, weight: 3, opacity: 0.9 }} />}
        {driven.length > 1 && <Polyline positions={driven} pathOptions={{ color: TRACK_COLOR, weight: 3, opacity: 0.95 }} />}
        {driven.length > 1 && (
          <Marker position={driven[0]} icon={dotIcon(START_COLOR)}>
            <Tooltip>
              <span style={{ fontSize: 11 }}>Start</span>
            </Tooltip>
          </Marker>
        )}
        {driven.length > 1 && (
          <Marker position={driven[driven.length - 1]} icon={dotIcon(END_COLOR)}>
            <Tooltip>
              <span style={{ fontSize: 11 }}>End</span>
            </Tooltip>
          </Marker>
        )}
        {waypoints.map((w) => (
          <Marker key={w.sequence} position={[w.lat, w.lng]} icon={wpIcon(w.sequence + 1, w.reached)}>
            <Tooltip>
              <span style={{ fontSize: 11 }}>
                {w.label || `Waypoint ${w.sequence + 1}`} · {w.lat.toFixed(5)}, {w.lng.toFixed(5)}
                {w.reached ? ' · reached' : ' · not reached'}
              </span>
            </Tooltip>
          </Marker>
        ))}
        {first && (
          <Marker position={[first.lat, first.lon]} icon={dotIcon(START_COLOR)}>
            <Tooltip>
              <span style={{ fontSize: 11 }}>Start {istHm(Date.parse(first.t))} IST</span>
            </Tooltip>
          </Marker>
        )}
        {last && track.length > 1 && (
          <Marker position={[last.lat, last.lon]} icon={dotIcon(END_COLOR)}>
            <Tooltip>
              <span style={{ fontSize: 11 }}>Last position {istHm(Date.parse(last.t))} IST</span>
            </Tooltip>
          </Marker>
        )}
        {position && (
          <Marker position={[position.lat, position.lon]} icon={dotIcon(LIVE_COLOR, 18)}>
            <Tooltip permanent direction="top" offset={[0, -10]}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{position.label}</span>
            </Tooltip>
          </Marker>
        )}
      </MapContainer>

      {/* Map type toggle (street / Google / Esri) */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 1000,
          display: 'flex',
          background: overlayBg,
          border: `1px solid ${overlayBdr}`,
          borderRadius: 6,
          overflow: 'hidden',
          backdropFilter: 'blur(4px)',
        }}
      >
        {[
          { type: 'street' as const, icon: <MapIcon size={12} />, label: 'Map', title: 'Street map' },
          { type: 'satellite' as const, icon: <Satellite size={12} />, label: 'Google', title: 'Google satellite — sharpest (to z20), may be older' },
          { type: 'esri' as const, icon: <Satellite size={12} />, label: 'Esri', title: 'Esri satellite — often newer, sharp to z18' },
        ].map(({ type, icon, label, title }) => {
          const active = mapType === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => setMapType(type)}
              title={title}
              aria-pressed={active}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '5px 9px',
                fontSize: 10,
                fontWeight: 600,
                background: active ? 'var(--accent)' : 'transparent',
                border: 'none',
                color: active ? '#fff' : theme === 'dark' ? 'rgba(255,255,255,0.75)' : '#444',
                cursor: 'pointer',
              }}
            >
              {icon}
              {label}
            </button>
          );
        })}
      </div>

      {isEsri && (
        <div
          style={{
            position: 'absolute',
            right: 6,
            bottom: 4,
            zIndex: 1000,
            fontSize: 9,
            padding: '1px 5px',
            borderRadius: 3,
            background: 'rgba(0,0,0,0.45)',
            color: 'rgba(255,255,255,0.85)',
            pointerEvents: 'none',
          }}
        >
          {ESRI_ATTRIBUTION}
        </div>
      )}

      {(track.length > 1 || position || planned.length > 0 || driven.length > 1) && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            padding: '6px 8px',
            borderRadius: 6,
            pointerEvents: 'none',
            background: theme === 'light' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)',
            border: `1px solid ${theme === 'light' ? '#d2d6dc' : '#2a2a2a'}`,
            fontSize: 10,
            color: theme === 'light' ? '#1f2937' : '#e5e7eb',
          }}
        >
          {planned.length > 0 && <LegendRow color={PLANNED_COLOR} dashed label="Planned" />}
          {reachedPts.length > 1 && <LegendRow color={REACHED_COLOR} label="Reached" />}
          {(track.length > 1 || driven.length > 1) && <LegendRow color={TRACK_COLOR} label="Actual path" />}
          {hasEst && <LegendRow color={theme === 'light' ? '#6b7280' : '#ffffff'} dashed label="Estimated (no reliable GPS)" />}
          {track.length > 1 && <LegendDot color={START_COLOR} label="Start" />}
          {track.length > 1 && <LegendDot color={END_COLOR} label="Last position" />}
          {position && <LegendDot color={LIVE_COLOR} label="Robot now" />}
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: color, border: '1.5px solid #fff', boxSizing: 'border-box' }} />
      <span>{label}</span>
    </div>
  );
}

function LegendRow({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 16, height: 0, borderTop: `3px ${dashed ? 'dashed' : 'solid'} ${color}` }} />
      <span>{label}</span>
    </div>
  );
}
