'use client';

import type { RobotAttachmentRefDto, RobotCategory } from '@arnobot/message-schema';
import { ImagePlus, Plane, Plus, Puzzle, Truck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { mediaUrl } from '@/components/domain/product-media';
import { cn } from '@/lib/cn';

/** "Rev A · SN SPR-0001 · SPR-20": which unit of an attachment, in a line (empty when nothing is recorded). */
export const attachmentUnit = (a: Pick<RobotAttachmentRefDto, 'model_number' | 'revision_name' | 'serial_number'>) =>
  [a.model_number, a.revision_name, a.serial_number ? `SN ${a.serial_number}` : null].filter(Boolean).join(' · ');

/** A small square picture: the photo when there is one, else an icon. */
export function Thumb({ photoId, icon, className }: { photoId: string | null | undefined; icon: ReactNode; className?: string }) {
  return photoId ? (
    // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
    <img src={mediaUrl(photoId)} alt="" loading="lazy" className={cn('shrink-0 rounded-lg border border-border object-cover', className)} />
  ) : (
    <span className={cn('flex shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text', className)} aria-hidden>
      {icon}
    </span>
  );
}

export const CategoryIcon = ({ category, className }: { category: RobotCategory; className?: string }) =>
  category === 'uav' ? <Plane className={className} style={{ color: `var(--cat-uav)` }} aria-hidden /> : <Truck className={className} style={{ color: `var(--cat-ugv)` }} aria-hidden />;

function BuildCard({ label, thumb, title, href, sub, action }: { label: string; thumb: ReactNode; title: string; href?: string; sub: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-2.5 pr-4 shadow-sm">
      {thumb}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold tracking-wide text-muted uppercase">{label}</span>
        {href ? (
          <Link href={href} className="block truncate text-base font-semibold text-accent-text hover:underline">
            {title}
          </Link>
        ) : (
          <span className="block truncate text-base font-semibold">{title}</span>
        )}
        <span className="block truncate text-sm text-muted">{sub}</span>
        {action}
      </span>
    </div>
  );
}

/**
 * What a robot is built from: its base model (category, revision) and every attachment fitted on it (model number,
 * revision, serial number), each with its photo and a link to its page. Shows "No attachment" plainly when none.
 */
export function RobotBuild({
  category,
  product,
  attachments,
  mainAttachmentId,
  onFit,
  onAttachmentMedia,
  className,
}: {
  category: RobotCategory;
  product: { id?: string; name: string; revision: string | null; coverPhotoId: string | null; modelNo?: number };
  attachments: RobotAttachmentRefDto[];
  /** The attachment the robot was built with: its number is part of the serial. */
  mainAttachmentId?: string | null;
  /** Shows a "Fit attachment" button. */
  onFit?: () => void;
  /** Shows a "Photos & 360°" button on each attachment (its own pictures, 360° view and 3D model). */
  onAttachmentMedia?: (a: RobotAttachmentRefDto) => void;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-2 sm:grid-cols-2 2xl:grid-cols-3', className)}>
      <BuildCard
        label="Base model"
        thumb={<Thumb photoId={product.coverPhotoId} icon={<CategoryIcon category={category} className="size-6" />} className="size-14" />}
        title={product.name}
        href={product.id ? `/products/${product.id}` : undefined}
        sub={
          <>
            <span className="font-semibold" style={{ color: `var(--cat-${category})` }}>
              {category.toUpperCase()}
            </span>
            {product.modelNo !== undefined && <> · No. {String(product.modelNo).padStart(3, '0')}</>} · {product.revision ?? 'revision not set'}
          </>
        }
      />
      {attachments.map((a) => (
        <BuildCard
          key={a.id}
          label="Attachment"
          thumb={<Thumb photoId={a.cover_photo_id} icon={<Puzzle className="size-6" />} className="size-14" />}
          title={a.name}
          href={`/attachments/${a.id}`}
          sub={[a.id === mainAttachmentId ? 'In the serial number' : null, attachmentUnit(a) || (a.id === mainAttachmentId ? null : 'revision and serial not recorded')].filter(Boolean).join(' · ')}
          action={
            onAttachmentMedia && (
              <button type="button" onClick={() => onAttachmentMedia(a)} className="mt-0.5 inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
                <ImagePlus className="size-3.5" aria-hidden /> Photos &amp; 360°
              </button>
            )
          }
        />
      ))}
      {attachments.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border p-2.5 pr-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted" aria-hidden>
            <Puzzle className="size-6" />
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold tracking-wide text-muted uppercase">Attachment</span>
            <span className="block text-base font-semibold">No attachment</span>
            {onFit && (
              <button type="button" onClick={onFit} className="text-sm font-medium text-accent-text hover:underline">
                Fit one
              </button>
            )}
          </span>
        </div>
      )}
      {onFit && attachments.length > 0 && (
        <button
          type="button"
          onClick={onFit}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border p-2.5 text-sm font-medium text-accent-text hover:border-accent hover:bg-accent-soft"
        >
          <Plus className="size-4" aria-hidden /> Fit or remove attachments
        </button>
      )}
    </div>
  );
}
