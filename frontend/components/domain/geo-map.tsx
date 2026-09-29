'use client';

import type { Map as MlMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface MapLine {
  id: string;
  /** [lon, lat] pairs (GeoJSON order). */
  coordinates: number[][];
  color: string;
  dashed?: boolean;
  width?: number;
}
export interface MapPoint {
  id: string;
  lon: number;
  lat: number;
  color: string;
  label?: string;
}

/**
 * Google map tiles, the same public tile servers the GCS uses (roadmap `lyrs=m`, satellite `lyrs=s`), spread over
 * mt0–mt3. No key. Unofficial route: Google may rate-limit or block it, and its terms restrict use outside Google's
 * own apps — swap `tiles` for a keyed provider (Google Map Tiles API, MapTiler) or self-hosted OSM tiles if needed.
 * Real detail to zoom 20; MapLibre over-zooms to 22.
 */
const googleTiles = (layer: 'm' | 's') => ['mt0', 'mt1', 'mt2', 'mt3'].map((s) => `https://${s}.google.com/vt/lyrs=${layer}&x={x}&y={y}&z={z}`);
const GOOGLE_ATTRIBUTION = 'Map data © Google';
const STYLE = {
  version: 8 as const,
  sources: {
    'google-road': { type: 'raster' as const, tiles: googleTiles('m'), tileSize: 256, maxzoom: 20, attribution: GOOGLE_ATTRIBUTION },
    'google-sat': { type: 'raster' as const, tiles: googleTiles('s'), tileSize: 256, maxzoom: 20, attribution: GOOGLE_ATTRIBUTION },
  },
  layers: [
    { id: 'google-road', type: 'raster' as const, source: 'google-road' },
    { id: 'google-sat', type: 'raster' as const, source: 'google-sat', layout: { visibility: 'none' as const } },
  ],
};

type BaseLayer = 'road' | 'satellite';
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

/**
 * Google has no dark roadmap: in dark mode the roadmap tiles are inverted (brightness min/max swapped) and
 * hue-rotated so water stays blue. Only the tile layer is touched, so robot tracks and markers keep their colours.
 * Satellite imagery is never inverted.
 */
function applyTheme(map: MlMap) {
  const dark = isDark();
  map.setPaintProperty('google-road', 'raster-brightness-min', dark ? 1 : 0);
  map.setPaintProperty('google-road', 'raster-brightness-max', dark ? 0.1 : 1);
  map.setPaintProperty('google-road', 'raster-hue-rotate', dark ? 180 : 0);
  map.setPaintProperty('google-road', 'raster-saturation', dark ? -0.3 : 0);
}

function cssVar(value: string): string {
  if (!value.startsWith('var(')) return value;
  const name = value.slice(4, -1).trim();
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#3b82f6';
}

/**
 * MapLibre map (client only). Lines and points are redrawn when props change; the view fits all
 * geometry. A text summary is provided for screen readers via `ariaLabel` + the legend outside.
 */
const NO_LINES: MapLine[] = [];
const NO_POINTS: MapPoint[] = [];

export function GeoMap({
  lines = NO_LINES,
  points = NO_POINTS,
  className,
  ariaLabel,
  onPointClick,
}: {
  lines?: MapLine[];
  points?: MapPoint[];
  className?: string;
  ariaLabel: string;
  /** Makes the points clickable (e.g. open that robot); hovering shows their label. */
  onPointClick?: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  // The view is fitted to the geometry once per set of ids, so live refreshes never undo the user's zoom / pan.
  const fittedFor = useRef<string | null>(null);
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [base, setBase] = useState<BaseLayer>('road');

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        // The bundled chunk can't find MapLibre's worker next to itself; serve it from public/
        // (copied by scripts/copy-maplibre-worker.mjs on predev/prebuild).
        maplibre.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
        if (cancelled || !container.current) return;
        map = new maplibre.Map({
          container: container.current,
          style: STYLE,
          center: [72.5714, 23.0225],
          zoom: 3,
          maxZoom: 22,
          attributionControl: { compact: true },
          cooperativeGestures: true,
        });
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          if (cancelled || !map) return;
          applyTheme(map);
          setReady(true);
        });
        // Point labels on hover; click → onPointClick (the layer is re-created on every data change, the handlers are not).
        const popup = new maplibre.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'pms-map-popup' });
        map.on('mouseenter', 'pms-points', (e) => {
          const f = e.features?.[0];
          if (!f || !map) return;
          map.getCanvas().style.cursor = clickRef.current ? 'pointer' : '';
          const label = String(f.properties?.label ?? '');
          if (label) popup.setLngLat((f.geometry as unknown as { coordinates: [number, number] }).coordinates).setText(label).addTo(map);
        });
        map.on('mouseleave', 'pms-points', () => {
          if (map) map.getCanvas().style.cursor = '';
          popup.remove();
        });
        map.on('click', 'pms-points', (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id && clickRef.current) clickRef.current(String(id));
        });
        mapRef.current = map;
      } catch {
        setFailed(true);
      }
    })();
    // Follow the panel's light / dark toggle.
    // (isStyleLoaded() is false while tiles are still loading, so it is not a usable guard here.)
    const themeObserver = new MutationObserver(() => {
      try {
        if (mapRef.current) applyTheme(mapRef.current);
      } catch {
        /* style not ready yet: the load handler applies the theme */
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // The map measures its box once at creation; a box that grows later (grid / tab layout settling) would
    // otherwise keep a narrow strip of tiles.
    const resizeObserver = new ResizeObserver(() => mapRef.current?.resize());
    if (container.current) resizeObserver.observe(container.current);
    return () => {
      cancelled = true;
      themeObserver.disconnect();
      resizeObserver.disconnect();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setLayoutProperty('google-road', 'visibility', base === 'road' ? 'visible' : 'none');
    map.setLayoutProperty('google-sat', 'visibility', base === 'satellite' ? 'visible' : 'none');
  }, [base, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const style = map.getStyle();
    for (const layer of style.layers ?? []) if (layer.id.startsWith('pms-')) map.removeLayer(layer.id);
    for (const id of Object.keys(style.sources ?? {})) if (id.startsWith('pms-')) map.removeSource(id);

    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const extend = (lon: number, lat: number) => {
      bounds[0] = Math.min(bounds[0], lon);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lon);
      bounds[3] = Math.max(bounds[3], lat);
    };

    for (const l of lines) {
      if (l.coordinates.length < 1) continue;
      const src = `pms-line-${l.id}`;
      map.addSource(src, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l.coordinates } } });
      map.addLayer({
        id: src,
        type: 'line',
        source: src,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': cssVar(l.color), 'line-width': l.width ?? 3.5, ...(l.dashed ? { 'line-dasharray': [2, 1.5] } : {}) },
      });
      for (const c of l.coordinates) extend(c[0], c[1]);
    }
    if (points.length) {
      map.addSource('pms-points', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: points.map((p) => ({ type: 'Feature', properties: { id: p.id, color: cssVar(p.color), label: p.label ?? '' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
        },
      });
      map.addLayer({
        id: 'pms-points',
        type: 'circle',
        source: 'pms-points',
        paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
      });
      for (const p of points) extend(p.lon, p.lat);
    }
    const fitKey = [...lines.map((l) => `l:${l.id}`), ...points.map((p) => `p:${p.id}`)].join('|');
    if (Number.isFinite(bounds[0]) && fittedFor.current !== fitKey) {
      fittedFor.current = fitKey;
      if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) map.jumpTo({ center: [bounds[0], bounds[1]], zoom: 16 });
      else map.fitBounds(bounds, { padding: 40, maxZoom: 18, duration: 0 });
    }
  }, [lines, points, ready]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-border bg-surface-2', className ?? 'h-80')}>
      {/* Explicit size: MapLibre sets `.maplibregl-map { position: relative }`, which would override
          `absolute inset-0` and collapse the container to 0 px high (blank map). */}
      <div ref={container} className="h-full w-full" role="region" aria-label={ariaLabel} />
      {ready && (
        <div role="group" aria-label="Map type" className="absolute top-2 left-2 z-10 flex overflow-hidden rounded-md border border-border bg-surface text-xs font-medium shadow-sm">
          {(['road', 'satellite'] as const).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={base === b}
              onClick={() => setBase(b)}
              className={cn('px-2.5 py-1.5', base === b ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-surface-2')}
            >
              {b === 'road' ? 'Map' : 'Satellite'}
            </button>
          ))}
        </div>
      )}
      {failed && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">Map could not be loaded.</p>}
    </div>
  );
}

export function MapLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-4 text-xs text-muted" aria-label="Map legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <svg width="28" height="8" aria-hidden>
            <line x1="1" y1="4" x2="27" y2="4" stroke={i.color} strokeWidth="3" strokeDasharray={i.dashed ? '5 4' : undefined} strokeLinecap="round" />
          </svg>
          {i.label}
        </li>
      ))}
    </ul>
  );
}
