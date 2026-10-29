'use client';

import type { RobotDirectoryEntryDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Puzzle } from 'lucide-react';
import Link from 'next/link';
import { useMemo, type MouseEvent } from 'react';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';

/** Every robot in a few words (nickname, base model, category, attachments), fetched once and shared by every RobotRef. */
export function useRobotDirectory() {
  const can = useCan();
  const q = useQuery({
    queryKey: ['robots', 'directory'],
    queryFn: () => api.get<RobotDirectoryEntryDto[]>('/robots/directory'),
    enabled: can('robot.details'),
    staleTime: 120_000,
  });
  return useMemo(() => new Map((q.data ?? []).map((r) => [r.robot_id, r])), [q.data]);
}

/** "saibya02 · Khavda patrol 1 — UGV · Saibya · Sprayer, Thermal camera": what a robot is, in one line, for tooltips. */
export function robotSummary(id: string, r?: RobotDirectoryEntryDto): string {
  if (!r) return id;
  const parts = [`${r.category.toUpperCase()} · ${r.product_name}`, r.attachments.length ? `Attachments: ${r.attachments.join(', ')}` : null, r.description, r.owner_company ? `Owner: ${r.owner_company}` : null];
  return `${id}${r.nickname ? ` · ${r.nickname}` : ''}\n${parts.filter(Boolean).join('\n')}`;
}

/**
 * A robot wherever it appears: its ID and nickname, with the category, base model and attachments under it
 * (`detail`), and its description on hover. So nobody has to open the robot to know which one it is.
 *  - `href`: link target (default the robot's page); `link={false}` for plain text.
 *  - `detail`: show the second line (tables, lists); off for tight spots (it is still in the tooltip).
 */
export function RobotRef({
  id,
  href,
  link = true,
  detail = true,
  className,
  onClick,
}: {
  id: string;
  href?: string;
  link?: boolean;
  detail?: boolean;
  className?: string;
  onClick?: (e: MouseEvent) => void;
}) {
  const dir = useRobotDirectory();
  const r = dir.get(id);
  const name = (
    <>
      <span className="font-mono font-semibold">{id}</span>
      {r?.nickname && <span className="font-semibold"> · {r.nickname}</span>}
    </>
  );
  return (
    <span className={cn('inline-block max-w-full min-w-0 align-top', className)} title={robotSummary(id, r)}>
      {link ? (
        <Link href={href ?? `/robots/${id}`} onClick={onClick} className="block truncate text-accent-text hover:underline">
          {name}
        </Link>
      ) : (
        <span className="block truncate">{name}</span>
      )}
      {detail && r && (
        <span className="block truncate text-sm font-normal text-muted">
          <span className="font-semibold" style={{ color: `var(--cat-${r.category})` }}>
            {r.category.toUpperCase()}
          </span>{' '}
          · {r.product_name}
          {r.attachments.length > 0 && (
            <>
              {' '}
              · <Puzzle className="inline size-3.5 align-[-2px]" aria-label="Attachments" /> {r.attachments.join(', ')}
            </>
          )}
        </span>
      )}
    </span>
  );
}
