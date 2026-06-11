/**
 * Reschedule pill — shows how many distinct due dates a work item has been given.
 * Rendered anywhere a work item appears (cards and rows). The count is precomputed
 * at data refresh and carried on the item (`due_count` / `due_dates`), so this is a
 * pure render with no fetching.
 *
 * Only shown once an item has had >= 2 due dates (i.e. it has been rescheduled at
 * least once); a date set once and never moved shows nothing.
 */
import { CalendarSync } from 'lucide-react';
import { fmtShortDate } from '@/lib/format';
import type { WorkItem } from '@/lib/types';

export function DueChangesPill({ item, className }: { item: WorkItem; className?: string }) {
  const count = item.due_count ?? 0;
  if (count < 2) return null;

  const dates = item.due_dates ?? [];
  const chain = dates.map(d => fmtShortDate(d)).join(' → ');
  const moves = count - 1;
  const title =
    `${count} due dates (rescheduled ${moves}×)` + (chain ? `: ${chain}` : '');

  return (
    <span className={'wi-due-pill' + (className ? ' ' + className : '')} title={title}>
      <CalendarSync className="h-3 w-3" />
      {count}
    </span>
  );
}
