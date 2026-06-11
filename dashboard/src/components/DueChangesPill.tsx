/**
 * Reschedule pill — shows how many DISTINCT due dates a work item has had.
 * Rendered anywhere a work item appears (cards and rows). The count is precomputed
 * at data refresh and carried on the item (`due_count` / `due_dates`), so this is a
 * pure render with no fetching.
 *
 * Only shown once an item has had >= 2 distinct due dates (i.e. it has been
 * rescheduled at least once). On hover it shows the date chain in a portal tooltip
 * (portal so it can't be clipped by a card/row's overflow).
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarSync } from 'lucide-react';
import { fmtShortDate } from '@/lib/format';
import type { WorkItem } from '@/lib/types';

export function DueChangesPill({ item, className }: { item: WorkItem; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const count = item.due_count ?? 0;
  if (count < 2) return null;

  const dates = item.due_dates ?? [];
  const chain = dates.map(d => fmtShortDate(d)).join('  →  ');

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: r.left + r.width / 2, y: r.top });
  };
  const hide = () => setTip(null);

  return (
    <span
      ref={ref}
      className={'wi-due-pill' + (className ? ' ' + className : '')}
      tabIndex={0}
      aria-label={`${count} distinct due dates${chain ? ': ' + chain : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <CalendarSync className="h-3 w-3" />
      {count}
      {tip && createPortal(
        <div className="wi-due-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <div className="wi-due-tip-head">{count} distinct due dates</div>
          {chain && <div className="wi-due-tip-chain">{chain}</div>}
        </div>,
        document.body,
      )}
    </span>
  );
}
