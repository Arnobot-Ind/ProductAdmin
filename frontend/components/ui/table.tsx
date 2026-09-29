'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ReactNode, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** When set, the header becomes a sort button. */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Row header cell (th scope=row) for the identifying column. */
  rowHeader?: boolean;
  /** Stays in view while the table scrolls sideways (first column of wide tables). */
  sticky?: boolean;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * Accessible data table: caption, th scope=col, sortable headers with aria-sort, sticky header,
 * horizontal scroll container on narrow screens.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  sort,
  onSort,
  onRowClick,
  empty,
  dense,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  sort?: SortState | null;
  onSort?: (s: SortState) => void;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr>
            {columns.map((c) => (
              <HeaderCell key={c.key} column={c} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-muted">
                {empty ?? 'No rows.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn('border-t border-border', onRowClick && 'cursor-pointer hover:bg-surface-2', rowClassName?.(row))}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => {
                  const cls = cn(dense ? 'px-3 py-1.5' : 'px-3 py-2.5', alignClass(c.align), c.className, c.sticky && 'sticky left-0 z-[1] bg-surface shadow-[1px_0_0_var(--border)]');
                  return c.rowHeader ? (
                    <th key={c.key} scope="row" className={cn(cls, 'font-medium')}>
                      {c.cell(row)}
                    </th>
                  ) : (
                    <td key={c.key} className={cls}>
                      {c.cell(row)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function alignClass(a?: 'left' | 'right' | 'center') {
  return a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';
}

function HeaderCell<T>({ column, sort, onSort }: { column: Column<T>; sort?: SortState | null; onSort?: (s: SortState) => void }) {
  const active = sort && column.sortKey && sort.key === column.sortKey;
  const ariaSort: ThHTMLAttributes<HTMLTableCellElement>['aria-sort'] = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : column.sortKey ? 'none' : undefined;
  const cls = cn(
    'px-3 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase',
    alignClass(column.align),
    column.className,
    column.sticky && 'sticky left-0 z-[2] bg-surface-2 shadow-[1px_0_0_var(--border)]',
  );
  if (!column.sortKey || !onSort) {
    return (
      <th scope="col" className={cls}>
        {column.header}
      </th>
    );
  }
  const Icon = active ? (sort!.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th scope="col" aria-sort={ariaSort} className={cls}>
      <button
        type="button"
        className="inline-flex items-center gap-1 uppercase hover:text-fg"
        onClick={() => onSort({ key: column.sortKey!, dir: active && sort!.dir === 'asc' ? 'desc' : 'asc' })}
      >
        {column.header}
        <Icon className="size-3.5" aria-hidden />
      </button>
    </th>
  );
}
