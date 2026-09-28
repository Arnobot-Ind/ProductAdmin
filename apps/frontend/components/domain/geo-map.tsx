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

/** OpenStreetMap raster tiles. Attribution is required by the OSM tile usage policy. */
const STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
};

function cssVar(value: string): string {
  if (!value.startsWith('var(')) return value;
  const name = value.slice(4, -1).trim();
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#3b82f6';
}

/**
 * MapLibre map (client only). Lines and points are redrawn when props change; the view fits all
 * geometry. A text summary is provided for screen readers via `ariaLabel` + the legend outside.
 */
export function GeoMap({ lines = [], points = [], className, ariaLabel }: { lines?: MapLine[]; points?: MapPoint[]; className?: string; ariaLabel: string }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

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
          attributionControl: { compact: true },
          cooperativeGestures: true,
        });
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          if (!cancelled) setReady(true);
        });
        mapRef.current = map;
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

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
          features: points.map((p) => ({ type: 'Feature', properties: { color: cssVar(p.color), label: p.label ?? '' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
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
    if (Number.isFinite(bounds[0])) {
      if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) map.jumpTo({ center: [bounds[0], bounds[1]], zoom: 16 });
      else map.fitBounds(bounds, { padding: 40, maxZoom: 18, duration: 0 });
    }
  }, [lines, points, ready]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-border bg-surface-2', className ?? 'h-80')}>
      {/* Explicit size: MapLibre sets `.maplibregl-map { position: relative }`, which would override
          `absolute inset-0` and collapse the container to 0 px high (blank map). */}
      <div ref={container} className="h-full w-full" role="region" aria-label={ariaLabel} />
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
