/**
 * Due Work view — 4-column board:
 *   1. Missing due date  (active items with no target_date)
 *   2. Due this week     (target_date today → this Saturday)
 *   3. Due next week     (Sunday after this Sat → next Sat)
 *   4. Due in 2 weeks    (the week after next)
 *
 * Past-due items are intentionally excluded (they live in Action Center).
 * Completed/cancelled items are excluded.
 *
 * Each card shows priority, ID, name, assignee, current state, time-in-state
 * (≈ days since updated_at, since Plane doesn't expose state-entry timestamps),
 * and the due date itself.
 */
import { useMemo, useRef, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';
import { PRIORITY_INFO, PRIORITY_RANK } from '@/lib/constants';
import { daysBetween, fmtShortDate, planeItemUrl, prioCls, projectPrefix } from '@/lib/format';
import { EditWorkItem } from '@/components/EditWorkItem';
import type { WorkItem } from '@/lib/types';

const fmtRange = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function endOfThisWeekSat(today: Date): Date {
  // Saturday = 6 in JS day-of-week (0=Sun .. 6=Sat).
  const day = today.getUTCDay();
  const offset = (6 - day + 7) % 7; // 0 if today is Sat
  const sat = new Date(today);
  sat.setUTCDate(sat.getUTCDate() + offset);
  return sat;
}

interface DueColumnProps {
  title: string;
  subtitle: string;
  count: number;
  tone: 'neutral' | 'bad' | 'warm' | 'cool';
  children: React.ReactNode;
  empty: string;
}
function DueColumn({ title, subtitle, count, tone, children, empty }: DueColumnProps) {
  return (
    <div className={'due-col due-col-' + tone}>
      <div className="due-col-head">
        <div className="flex items-center gap-2">
          <span className="due-col-dot" />
          <span className="due-col-title">{title}</span>
          <span className="due-col-count">{count}</span>
        </div>
        <div className="due-col-sub">{subtitle}</div>
      </div>
      <div className="due-col-body">
        {count === 0 ? <div className="due-col-empty">{empty}</div> : children}
      </div>
    </div>
  );
}

/**
 * Inline "Set due date" button — click pops the browser's native date picker
 * via input.showPicker(); on change we PATCH target_date and trigger a refresh
 * so the card relocates to the correct column automatically.
 */
function QuickDueDate({ item }: { item: WorkItem }) {
  const { currentProjectId, refresh } = useDashboard();
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = () => {
    setErr(null);
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') el.showPicker();
    else { el.focus(); el.click(); }
  };

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const date = e.target.value;
    if (!date || !currentProjectId) return;
    setSaving(true);
    setErr(null);
    try {
      await api.patchWorkItem(currentProjectId, item.id, { target_date: date });
      await refresh();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="due-card-set-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); open(); }}
        disabled={saving}
        className="due-card-set"
        title={err || 'Set due date'}
      >
        <CalendarPlus className="h-3.5 w-3.5" />
        {saving ? 'Saving…' : 'Set due'}
      </button>
      <input
        ref={inputRef}
        type="date"
        onChange={onChange}
        className="due-card-set-input"
        aria-label="Pick a due date"
      />
    </span>
  );
}

interface DueCardProps {
  item: WorkItem;
  projIdent: string;
  meta: { workspace_slug?: string } | undefined;
  today: string;
  /** Render the inline "Set due date" button instead of the due-date label. */
  isMissing?: boolean;
}
function DueCard({ item, projIdent, meta, today, isMissing }: DueCardProps) {
  const url = planeItemUrl(item.seq, { id: '', identifier: projIdent }, meta);
  const prio = PRIORITY_INFO[item.priority] || PRIORITY_INFO.none;
  const sinceUpdated = daysBetween(item.updated_at, today);
  return (
    <div className="due-card">
      <div className="due-card-head">
        <span className={'badge ' + prioCls(item.priority)}>{prio.label}</span>
        <a href={url} target="_blank" rel="noopener" className="due-card-seq">{projIdent}-{item.seq}</a>
        {isMissing
          ? <span className="ml-auto"><QuickDueDate item={item} /></span>
          : item.end
            ? <span className="due-card-due">Due {fmtShortDate(item.end)}</span>
            : null}
      </div>
      <a href={url} target="_blank" rel="noopener" className="due-card-name">{item.name}</a>
      <div className="due-card-meta">
        <span className={'badge b-' + item.state_group}>{item.state}</span>
        {sinceUpdated !== null && (
          <span className="due-card-time" title="≈ days since last update (proxy for time in state)">
            ~{sinceUpdated}d in state
          </span>
        )}
      </div>
      <div className="due-card-foot">
        {item.assignee
          ? <span className="due-card-assignee">{item.assignee}</span>
          : <em className="due-card-unassigned">unassigned</em>}
        <span className="ml-auto"><EditWorkItem item={item} /></span>
      </div>
    </div>
  );
}

const sortByUrgency = (a: WorkItem, b: WorkItem) => {
  // Earlier due date first; same date → higher priority first.
  if (a.end && b.end && a.end !== b.end) return a.end < b.end ? -1 : 1;
  return (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
};

export function DueWorkView() {
  const { data, currentProject } = useDashboard();

  const buckets = useMemo(() => {
    if (!data) return null;
    const today = new Date(data.today + 'T00:00:00Z');
    const wkEnd1 = endOfThisWeekSat(today);
    const wkEnd2 = new Date(wkEnd1); wkEnd2.setUTCDate(wkEnd2.getUTCDate() + 7);
    const wkEnd3 = new Date(wkEnd2); wkEnd3.setUTCDate(wkEnd3.getUTCDate() + 7);

    const missing: WorkItem[] = [];
    const thisWeek: WorkItem[] = [];
    const nextWeek: WorkItem[] = [];
    const twoWeeks: WorkItem[] = [];

    for (const i of data.items) {
      const sg = i.state_group;
      const isClosed = sg === 'completed' || sg === 'cancelled';
      if (isClosed) continue;
      const isActive = sg === 'started' || sg === 'unstarted';
      if (!i.end) {
        if (isActive) missing.push(i);
        continue;
      }
      const due = new Date(i.end + 'T00:00:00Z');
      if (due < today) continue;          // past due → Action Center handles it
      if (due <= wkEnd1) thisWeek.push(i);
      else if (due <= wkEnd2) nextWeek.push(i);
      else if (due <= wkEnd3) twoWeeks.push(i);
      // > 3 weeks out: not shown in this view
    }

    missing.sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0));
    thisWeek.sort(sortByUrgency);
    nextWeek.sort(sortByUrgency);
    twoWeeks.sort(sortByUrgency);

    return {
      missing, thisWeek, nextWeek, twoWeeks,
      labels: {
        thisWeek: `today → Sat ${fmtRange(wkEnd1)}`,
        nextWeek: `${fmtRange(new Date(wkEnd1.getTime() + 86400000))} → Sat ${fmtRange(wkEnd2)}`,
        twoWeeks: `${fmtRange(new Date(wkEnd2.getTime() + 86400000))} → Sat ${fmtRange(wkEnd3)}`,
      },
    };
  }, [data]);

  if (!data || !buckets) return <div className="text-sm text-muted-foreground p-4">No data.</div>;
  const projIdent = projectPrefix(currentProject);
  const meta = data._meta;
  const today = data.today;

  const card = (it: WorkItem) => (
    <DueCard key={it.id} item={it} projIdent={projIdent} meta={meta} today={today} />
  );
  const missingCard = (it: WorkItem) => (
    <DueCard key={it.id} item={it} projIdent={projIdent} meta={meta} today={today} isMissing />
  );

  return (
    <div className="space-y-3">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="kpi kpi-cool">
          <div className="kpi-label"><span className="kpi-dot" />Missing due date</div>
          <div className="kpi-value">{buckets.missing.length}</div>
          <div className="kpi-sub">active items with no target_date</div>
        </div>
        <div className={'kpi ' + (buckets.thisWeek.length > 0 ? 'kpi-bad' : 'kpi-good')}>
          <div className="kpi-label"><span className="kpi-dot" />Due this week</div>
          <div className="kpi-value">{buckets.thisWeek.length}</div>
          <div className="kpi-sub">{buckets.labels.thisWeek}</div>
        </div>
        <div className="kpi kpi-warm">
          <div className="kpi-label"><span className="kpi-dot" />Due next week</div>
          <div className="kpi-value">{buckets.nextWeek.length}</div>
          <div className="kpi-sub">{buckets.labels.nextWeek}</div>
        </div>
        <div className="kpi kpi-violet">
          <div className="kpi-label"><span className="kpi-dot" />Due in 2 weeks</div>
          <div className="kpi-value">{buckets.twoWeeks.length}</div>
          <div className="kpi-sub">{buckets.labels.twoWeeks}</div>
        </div>
      </section>

      <div className="due-board">
        <DueColumn
          title="Missing due date"
          subtitle="click + on a card to set one"
          tone="neutral"
          count={buckets.missing.length}
          empty="All active items have due dates."
        >
          {buckets.missing.map(missingCard)}
        </DueColumn>
        <DueColumn
          title="Due this week"
          subtitle={buckets.labels.thisWeek}
          tone="bad"
          count={buckets.thisWeek.length}
          empty="Nothing due this week."
        >
          {buckets.thisWeek.map(card)}
        </DueColumn>
        <DueColumn
          title="Due next week"
          subtitle={buckets.labels.nextWeek}
          tone="warm"
          count={buckets.nextWeek.length}
          empty="Nothing due next week."
        >
          {buckets.nextWeek.map(card)}
        </DueColumn>
        <DueColumn
          title="Due in 2 weeks"
          subtitle={buckets.labels.twoWeeks}
          tone="cool"
          count={buckets.twoWeeks.length}
          empty="Nothing due in 2 weeks."
        >
          {buckets.twoWeeks.map(card)}
        </DueColumn>
      </div>
    </div>
  );
}
