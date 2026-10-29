'use client';

import type { ProductMediaDto, ProductMediaKind } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, ChevronLeft, ChevronRight, Image as ImageIcon, Pause, Play, RotateCw, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Card, EmptyState, InlineAlert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, downloadUrl, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtBytes } from '@/lib/format';

/*
 * What a product looks like, three ways (all optional, uploaded on the product page):
 *  - photos;
 *  - a 360° view: a series of photos taken all around the robot, shown in order as you drag;
 *  - a 3D model (.glb) that turns with the mouse or a finger.
 */

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        alt?: string;
        'camera-controls'?: boolean | string;
        'auto-rotate'?: boolean | string;
        'with-credentials'?: boolean | string;
        'shadow-intensity'?: string;
        exposure?: string;
        'interaction-prompt'?: string;
      };
    }
  }
}

export const mediaUrl = (id: string) => downloadUrl(`/product-media/${id}/file`);

/** Whose pictures: a base model's or an attachment's (both keep the same kinds). */
export type MediaOwner = 'products' | 'attachments';
const ownerKey = (owner: MediaOwner) => (owner === 'products' ? 'product' : 'attachment');

export function useProductMedia(productId: string | null | undefined, enabled = true, owner: MediaOwner = 'products') {
  return useQuery({
    queryKey: [ownerKey(owner), productId, 'media'],
    queryFn: () => api.get<ProductMediaDto[]>(`/${owner}/${productId}/media`),
    enabled: !!productId && enabled,
    staleTime: 300_000,
  });
}

const split = (items: ProductMediaDto[]) => ({
  photos: items.filter((m) => m.kind === 'photo'),
  spin: items.filter((m) => m.kind === 'spin').sort((a, b) => a.position - b.position),
  model: items.find((m) => m.kind === 'model_3d') ?? null,
});

type View = 'photos' | 'spin' | 'model';

/**
 * The robot page's picture: the first photo (or the 360° view's first frame) as a thumbnail, with buttons for
 * whatever else exists. Opens a large viewer. Shows a plain placeholder until something is uploaded.
 */
export function ProductPicture({ productId, name, className }: { productId: string; name: string; className?: string }) {
  const can = useCan();
  const q = useProductMedia(productId, can('catalog.read'));
  const [open, setOpen] = useState<View | null>(null);
  const { photos, spin, model } = split(q.data ?? []);
  const cover = photos[0] ?? spin[0];
  const views: { id: View; label: string; Icon: typeof Box }[] = [
    ...(photos.length ? [{ id: 'photos' as const, label: `${photos.length} photo${photos.length === 1 ? '' : 's'}`, Icon: ImageIcon }] : []),
    ...(spin.length ? [{ id: 'spin' as const, label: '360° view', Icon: RotateCw }] : []),
    ...(model ? [{ id: 'model' as const, label: '3D model', Icon: Box }] : []),
  ];
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        disabled={!views.length}
        onClick={() => setOpen(views[0]?.id ?? null)}
        className="group relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2 enabled:hover:border-accent/50"
        aria-label={views.length ? `View pictures of ${name}` : `No pictures of ${name} yet`}
      >
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
          <img src={mediaUrl(cover.id)} alt="" className="size-full object-contain transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <span className="flex flex-col items-center gap-1 px-3 text-center text-sm text-muted">
            <ImageIcon className="size-8" aria-hidden />
            No photo yet
          </span>
        )}
      </button>
      {views.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {views.map((v) => (
            <button key={v.id} type="button" onClick={() => setOpen(v.id)} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-sm font-medium hover:border-accent/50">
              <v.Icon className="size-3.5" aria-hidden /> {v.label}
            </button>
          ))}
        </div>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={name} size="xl">
          <div role="tablist" aria-label="View" className="mb-4 flex flex-wrap gap-2">
            {views.map((v) => (
              <button
                key={v.id}
                role="tab"
                type="button"
                aria-selected={open === v.id}
                onClick={() => setOpen(v.id)}
                className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium', open === v.id ? 'border-accent bg-accent-soft text-accent-text' : 'border-border hover:border-accent/50')}
              >
                <v.Icon className="size-4" aria-hidden /> {v.label}
              </button>
            ))}
          </div>
          {open === 'photos' && <PhotoViewer photos={photos} />}
          {open === 'spin' && <SpinViewer frames={spin} />}
          {open === 'model' && model && <ModelViewer src={mediaUrl(model.id)} alt={`3D model of ${name}`} />}
        </Dialog>
      )}
    </div>
  );
}

function PhotoViewer({ photos }: { photos: ProductMediaDto[] }) {
  const [i, setI] = useState(0);
  const p = photos[Math.min(i, photos.length - 1)];
  return (
    <div>
      <div className="relative flex h-[60vh] items-center justify-center overflow-hidden rounded-lg bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API image */}
        <img src={mediaUrl(p.id)} alt={p.caption ?? ''} className="max-h-full max-w-full object-contain" />
        {photos.length > 1 && (
          <>
            <button type="button" onClick={() => setI((i - 1 + photos.length) % photos.length)} aria-label="Previous photo" className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-surface/90 p-2 shadow hover:bg-surface">
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button type="button" onClick={() => setI((i + 1) % photos.length)} aria-label="Next photo" className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-surface/90 p-2 shadow hover:bg-surface">
              <ChevronRight className="size-5" aria-hidden />
            </button>
          </>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {p.caption ?? p.filename} · {i + 1} of {photos.length}
      </p>
    </div>
  );
}

/**
 * 360° view: drag left / right (or use the arrow keys, or Play) to turn the robot through its photo series.
 * Every frame is loaded up front so turning is smooth.
 */
export function SpinViewer({ frames, className, style }: { frames: ProductMediaDto[]; className?: string; style?: CSSProperties }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const drag = useRef<{ x: number; i: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const n = frames.length;
  useEffect(() => {
    let done = 0;
    const imgs = frames.map((f) => {
      const im = new window.Image();
      im.onload = im.onerror = () => setLoaded(++done);
      im.src = mediaUrl(f.id);
      return im;
    });
    return () => imgs.forEach((im) => (im.onload = im.onerror = null));
  }, [frames]);
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % n), 90);
    return () => window.clearInterval(t);
  }, [playing, n]);
  const onDown = (e: ReactPointerEvent) => {
    setPlaying(false);
    drag.current = { x: e.clientX, i };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current || !box.current) return;
    // One full turn across the width of the viewer.
    const step = box.current.clientWidth / n;
    const d = Math.round((drag.current.x - e.clientX) / step);
    setI((((drag.current.i + d) % n) + n) % n);
  };
  return (
    <div className={className}>
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Turn the robot"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={i + 1}
        aria-valuetext={`Angle ${Math.round((i / n) * 360)}°`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setI((i - 1 + n) % n);
          if (e.key === 'ArrowRight') setI((i + 1) % n);
        }}
        className="relative flex h-[60vh] cursor-grab touch-pan-y items-center justify-center overflow-hidden rounded-lg bg-surface-2 select-none active:cursor-grabbing"
        style={style}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API image */}
        <img src={mediaUrl(frames[i].id)} alt="" draggable={false} className="pointer-events-none max-h-full max-w-full object-contain" />
        {loaded < n && <span className="absolute bottom-3 left-3 rounded-full bg-surface/90 px-3 py-1 text-sm">Loading {loaded} of {n} photos…</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted">
        <Button size="sm" icon={playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />} onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <input type="range" min={0} max={n - 1} value={i} onChange={(e) => setI(Number(e.target.value))} aria-label="Angle" className="min-w-40 flex-1 accent-[var(--accent)]" />
        <span className="tabular-nums">{Math.round((i / n) * 360)}°</span>
        <span>Drag the picture to turn it.</span>
      </div>
    </div>
  );
}

/** A 3D model (.glb) the viewer turns with the mouse or a finger; loads the viewer only when needed. */
export function ModelViewer({ src, alt }: { src: string; alt: string }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    import('@google/model-viewer').then(
      () => setReady(true),
      (e) => setError(errorMessage(e)),
    );
  }, []);
  if (error) return <InlineAlert tone="fault">The 3D viewer could not load: {error}</InlineAlert>;
  return (
    <div className="h-[60vh] overflow-hidden rounded-lg bg-surface-2">
      {ready ? (
        <model-viewer src={src} alt={alt} camera-controls="" auto-rotate="" with-credentials="" shadow-intensity="1" exposure="1" interaction-prompt="auto" style={{ width: '100%', height: '100%' }} />
      ) : (
        <p className="p-4 text-sm text-muted">Loading the 3D viewer…</p>
      )}
    </div>
  );
}

// ── product page: upload and manage ─────────────────────────────────────────

/** Base model or attachment page: upload photos, a 360° photo series, or a 3D model; remove them again. */
export function ProductMediaCard({ productId, name, owner = 'products' }: { productId: string; name: string; owner?: MediaOwner }) {
  const can = useCan();
  const canWrite = can('catalog.write');
  const q = useProductMedia(productId, true, owner);
  const thing = owner === 'products' ? 'robot' : 'attachment';
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<{ kind: ProductMediaKind; done: number; total: number } | null>(null);
  const [removing, setRemoving] = useState<ProductMediaDto | 'spin' | null>(null);
  const { photos, spin, model } = split(q.data ?? []);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [ownerKey(owner), productId] });
    void qc.invalidateQueries({ queryKey: [owner] });
  };
  /** Uploads one file at a time, in order (the 360° series keeps the order of the file names). */
  const upload = async (kind: ProductMediaKind, files: File[]) => {
    const list = kind === 'spin' ? [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : files;
    setBusy({ kind, done: 0, total: list.length });
    try {
      for (let i = 0; i < list.length; i++) {
        const fd = new FormData();
        fd.set('kind', kind);
        fd.set('file', list[i]);
        await api.upload<ProductMediaDto>(`/${owner}/${productId}/media`, fd);
        setBusy({ kind, done: i + 1, total: list.length });
      }
      toast.success(kind === 'model_3d' ? '3D model uploaded' : kind === 'spin' ? `360° view: ${list.length} photos added` : `${list.length} photo${list.length === 1 ? '' : 's'} uploaded`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const remove = useMutation({
    mutationFn: (m: ProductMediaDto | 'spin') => (m === 'spin' ? api.del(`/${owner}/${productId}/spin`) : api.del(`/product-media/${m.id}`)),
    onSuccess: () => {
      toast.success('Removed');
      setRemoving(null);
      refresh();
    },
    onError: toast.error,
  });

  return (
    <Card title="Photos & 3D" bodyClassName="flex flex-col gap-6 p-5">
      {busy && (
        <InlineAlert tone="accent">
          Uploading {busy.done + 1 > busy.total ? busy.total : busy.done + 1} of {busy.total}…
        </InlineAlert>
      )}

      <section aria-labelledby="pm-photos">
        <MediaHeader id="pm-photos" title="Photos" hint={`${owner === 'products' ? 'Shown on the page of every robot of this base model' : 'Shown on this page and with the attachment on every robot that has it fitted'}. PNG, JPEG, WebP, GIF or AVIF.`} canWrite={canWrite} busy={!!busy} accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple onFiles={(f) => void upload('photo', f)} button="Add photos" />
        {photos.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {photos.map((p) => (
              <li key={p.id} className="group relative overflow-hidden rounded-lg border border-border bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API image */}
                <img src={mediaUrl(p.id)} alt={p.caption ?? p.filename} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                {canWrite && (
                  <button type="button" onClick={() => setRemoving(p)} aria-label={`Remove ${p.filename}`} className="absolute top-1.5 right-1.5 rounded-md bg-surface/90 p-1.5 opacity-0 shadow group-hover:opacity-100 focus:opacity-100">
                    <Trash2 className="size-4 text-fault" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base text-muted">No photos yet.</p>
        )}
      </section>

      <section aria-labelledby="pm-spin" className="border-t border-border pt-5">
        <MediaHeader
          id="pm-spin"
          title="360° view from a photo series"
          hint={`Walk around the ${thing} and take a photo every 10–15° (24–36 photos), same height and distance. Name the files in order (01.jpg, 02.jpg …). Up to 120 photos.`}
          canWrite={canWrite}
          busy={!!busy}
          accept="image/png,image/jpeg,image/webp"
          multiple
          onFiles={(f) => void upload('spin', f)}
          button={spin.length ? 'Add more photos' : 'Upload photo series'}
          extra={
            canWrite && spin.length > 0 ? (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setRemoving('spin')}>
                Remove series
              </Button>
            ) : undefined
          }
        />
        {spin.length ? <SpinViewer frames={spin} style={{ height: '22rem' }} /> : <p className="text-base text-muted">No 360° view yet.</p>}
      </section>

      <section aria-labelledby="pm-model" className="border-t border-border pt-5">
        <MediaHeader
          id="pm-model"
          title="3D model"
          hint="A binary glTF file (.glb). Most 3D tools and photo-to-3D apps export it. Uploading a new one replaces the old one."
          canWrite={canWrite}
          busy={!!busy}
          accept=".glb,model/gltf-binary"
          onFiles={(f) => void upload('model_3d', f.slice(0, 1))}
          button={model ? 'Replace 3D model' : 'Upload 3D model'}
          extra={
            canWrite && model ? (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setRemoving(model)}>
                Remove
              </Button>
            ) : undefined
          }
        />
        {model ? (
          <>
            <ModelViewer src={mediaUrl(model.id)} alt={`3D model of ${name}`} />
            <p className="mt-2 text-sm text-muted">
              {model.filename} · {fmtBytes(model.size_bytes)}
            </p>
          </>
        ) : (
          <EmptyState icon={<Box className="size-8" />} title="No 3D model yet" description="Upload a .glb file, or use the 360° view above with a series of photos." />
        )}
      </section>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        danger
        title={removing === 'spin' ? 'Remove the 360° view?' : 'Remove this file?'}
        description={`It disappears from the ${owner === 'products' ? 'base model' : 'attachment'} and robot pages. The file itself is kept in storage.`}
        confirmLabel="Remove"
      />
    </Card>
  );
}

function MediaHeader({
  id,
  title,
  hint,
  canWrite,
  busy,
  accept,
  multiple,
  onFiles,
  button,
  extra,
}: {
  id: string;
  title: string;
  hint: string;
  canWrite: boolean;
  busy: boolean;
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  button: string;
  extra?: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-72">
        <h3 id={id} className="text-lg font-semibold">
          {title}
        </h3>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {canWrite && (
        <div className="flex gap-2">
          {extra}
          <input
            ref={input}
            type="file"
            accept={accept}
            multiple={multiple}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) onFiles(files);
            }}
          />
          <Button size="sm" variant="primary" icon={<Upload className="size-4" aria-hidden />} onClick={() => input.current?.click()} disabled={busy}>
            {button}
          </Button>
        </div>
      )}
    </div>
  );
}
