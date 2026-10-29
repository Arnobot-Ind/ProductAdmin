'use client';

import type { Paginated, RobotNoteDto } from '@arnobot/message-schema';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox, Input, Textarea } from '@/components/ui/field';
import { Card, EmptyState, Pagination, QueryView } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtWhen } from '@/lib/format';
import { useDebounced, useNow } from '@/lib/hooks';

export function useRobotNotes(robotId: string, q = '', page = 1) {
  return useQuery({
    queryKey: ['robot', robotId, 'notes', q, page],
    queryFn: () => api.get<Paginated<RobotNoteDto>>(`/robots/${robotId}/notes`, { q: q || undefined, page, limit: 20 }),
    placeholderData: keepPreviousData,
  });
}

/**
 * Records → Journal: dated notes about this robot, so anyone can see years later what happened and why
 * (site visits, decisions, customer requests, anything not captured elsewhere). Pinned notes stay on top and
 * show on the robot's header. Notes are never edited; write a new one to correct an old one.
 */
export function NotesTab({ robotId }: { robotId: string }) {
  const can = useCan();
  const canWrite = can('robot.write');
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(60_000);
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<RobotNoteDto | null>(null);
  const q = useDebounced(text.trim(), 300);
  const notes = useRobotNotes(robotId, q, page);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['robot', robotId, 'notes'] });
  const add = useMutation({
    mutationFn: () => api.post<RobotNoteDto>(`/robots/${robotId}/notes`, { body: body.trim(), pinned }),
    onSuccess: () => {
      toast.success('Note saved');
      setBody('');
      setPinned(false);
      refresh();
    },
    onError: toast.error,
  });
  const pin = useMutation({ mutationFn: (n: RobotNoteDto) => api.patch(`/notes/${n.id}`, { pinned: !n.pinned }), onSuccess: refresh, onError: toast.error });
  const remove = useMutation({
    mutationFn: (n: RobotNoteDto) => api.del(`/notes/${n.id}`),
    onSuccess: () => {
      toast.success('Note removed (kept in the record)');
      setRemoving(null);
      refresh();
    },
    onError: toast.error,
  });

  return (
    <div className="flex flex-col gap-5">
      {canWrite && (
        <Card title="Add a note" bodyClassName="flex flex-col gap-3 p-5">
          <Textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={10_000}
            placeholder="What happened, what was decided, what the next person should know… e.g. Battery pack replaced at the Khavda site after BMS fault; old pack returned to the workshop."
            aria-label="Note"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Checkbox label="Pin it (keep it on top and on the robot's header)" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            <Button variant="primary" icon={<NotebookPen className="size-4" aria-hidden />} onClick={() => add.mutate()} loading={add.isPending} disabled={!body.trim()}>
              Save note
            </Button>
          </div>
        </Card>
      )}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPage(1);
          }}
          placeholder="Search the journal"
          aria-label="Search the journal"
          className="pl-9"
          type="search"
        />
      </div>

      <QueryView query={notes} rows={4}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState icon={<NotebookPen className="size-8" />} title={q ? 'No note matches' : 'No notes yet'} description={q ? 'Try another word.' : 'Notes you add here stay with this robot for good.'} />
          ) : (
            <>
              <ol className="flex flex-col gap-3">
                {d.items.map((n) => (
                  <li key={n.id} className={cn('rounded-xl border bg-surface p-4 shadow-sm', n.pinned ? 'border-accent/50 bg-accent-soft/40' : 'border-border')}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
                      <span>
                        {n.pinned && (
                          <span className="mr-2 inline-flex items-center gap-1 font-semibold text-accent-text">
                            <Pin className="size-3.5" aria-hidden /> Pinned
                          </span>
                        )}
                        <span className="font-medium text-fg">{n.created_by_name ?? 'Someone'}</span> · {fmtWhen(n.created_at, now)} ({fmtAgo(n.created_at, now).toLowerCase()})
                      </span>
                      {canWrite && (
                        <span className="flex gap-1">
                          <Button size="sm" variant="ghost" icon={n.pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />} onClick={() => pin.mutate(n)}>
                            {n.pinned ? 'Unpin' : 'Pin'}
                          </Button>
                          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setRemoving(n)} aria-label="Remove note">
                            Remove
                          </Button>
                        </span>
                      )}
                    </div>
                    <p className="text-base break-words whitespace-pre-wrap">{n.body}</p>
                  </li>
                ))}
              </ol>
              <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        danger
        title="Remove this note?"
        description="It disappears from the journal but is kept in the database, and the removal is written to the audit log."
        confirmLabel="Remove"
      />
    </div>
  );
}

/** The pinned notes, small, under the robot's header (only when there are any). */
export function PinnedNotes({ robotId, onOpen }: { robotId: string; onOpen: () => void }) {
  const can = useCan();
  const q = useQuery({
    queryKey: ['robot', robotId, 'notes', 'pinned'],
    queryFn: () => api.get<Paginated<RobotNoteDto>>(`/robots/${robotId}/notes`, { limit: 3 }),
    enabled: can('robot.details'),
    staleTime: 60_000,
  });
  const pinned = (q.data?.items ?? []).filter((n) => n.pinned);
  if (!pinned.length) return null;
  return (
    <ul className="mt-3 flex flex-col gap-2" aria-label="Pinned notes">
      {pinned.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={onOpen} className="flex w-full items-start gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-left text-base hover:border-accent">
            <Pin className="mt-1 size-4 shrink-0 text-accent-text" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{n.body}</span>
            <span className="shrink-0 text-sm text-muted">{fmtWhen(n.created_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
