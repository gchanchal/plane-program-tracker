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
import { CalendarPlus, ChevronDown, ChevronRight, AlertTriangle, Search, X } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';
import { PRIORITY_INFO, PRIORITY_RANK } from '@/lib/constants';
import { daysBetween, fmtShortDate, planeItemUrl, prioCls, projectPrefix } from '@/lib/format';
import { EditWorkItem } from '@/components/EditWorkItem';
import { DueChangesPill } from '@/components/DueChangesPill';
import { MultiSelectChip, type MultiSelectOption } from '@/components/MultiSelectChip';
import type { Priority, WorkItem } from '@/lib/types';

interface Filters {
  state: Set<string>;
  priority: Set<string>;
  type: Set<string>;
  assignee: Set<string>;
  label: Set<string>;
}

const EMPTY_FILTERS: Filters = {
  state: new Set(),
  priority: new Set(),
  type: new Set(),
  assignee: new Set(),
  label: new Set(),
};

function applyFilters(items: WorkItem[], f: Filters): WorkItem[] {
  return items.filter(i => {
    if (f.state.size && !f.state.has(i.state)) return false;
    if (f.priority.size && !f.priority.has(i.priority)) return false;
    if (f.type.size && !f.type.has(i.type)) return false;
    if (f.assignee.size) {
      const key = i.assignee_id || '__unassigned__';
      if (!f.assignee.has(key)) return false;
    }
    if (f.label.size) {
      const ids = (i.labels || []).map(l => l.id);
      if (ids.length === 0) {
        if (!f.label.has('__nolabel__')) return false;
      } else if (!ids.some(id => f.label.has(id))) {
        return false;
      }
    }
    return true;
  });
}

function buildOptions(items: WorkItem[]) {
  const state = new Map<string, number>();
  const prio = new Map<Priority, number>();
  const type = new Map<string, number>();
  const assignee = new Map<string, { label: string; color?: string; count: number }>();
  const label = new Map<string, { label: string; color?: string; count: number }>();
  let noLabelCount = 0;

  for (const i of items) {
    state.set(i.state, (state.get(i.state) || 0) + 1);
    prio.set(i.priority, (prio.get(i.priority) || 0) + 1);
    type.set(i.type, (type.get(i.type) || 0) + 1);
    const aKey = i.assignee_id || '__unassigned__';
    const aLabel = i.assignee || 'Unassigned';
    const existing = assignee.get(aKey);
    if (existing) existing.count += 1;
    else assignee.set(aKey, { label: aLabel, color: i.assignee_color, count: 1 });
    if (!i.labels || i.labels.length === 0) {
      noLabelCount += 1;
    } else {
      for (const l of i.labels) {
        const e = label.get(l.id);
        if (e) e.count += 1;
        else label.set(l.id, { label: l.name, color: l.color, count: 1 });
      }
    }
  }

  const stateOpts: MultiSelectOption[] = Array.from(state.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([v, c]) => ({ value: v, label: v, count: c }));

  const PRIO_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
  const prioOpts: MultiSelectOption[] = PRIO_ORDER
    .filter(p => prio.has(p))
    .map(p => ({
      value: p,
      label: PRIORITY_INFO[p].label,
      color: PRIORITY_INFO[p].color,
      count: prio.get(p) || 0,
    }));

  const typeOpts: MultiSelectOption[] = Array.from(type.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([v, c]) => ({ value: v, label: v, count: c }));

  const assigneeOpts: MultiSelectOption[] = Array.from(assignee.entries())
    .sort((a, b) => {
      if (a[0] === '__unassigned__') return 1;
      if (b[0] === '__unassigned__') return -1;
      return a[1].label.localeCompare(b[1].label);
    })
    .map(([v, m]) => ({ value: v, label: m.label, color: m.color, count: m.count }));

  const labelOpts: MultiSelectOption[] = Array.from(label.entries())
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
    .map(([v, m]) => ({ value: v, label: m.label, color: m.color, count: m.count }));
  if (noLabelCount > 0) {
    labelOpts.push({ value: '__nolabel__', label: 'No labels', count: noLabelCount });
  }

  return { stateOpts, prioOpts, typeOpts, assigneeOpts, labelOpts };
}

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
  /** Called when a DueCard is dropped into this column. */
  onDropItem?: (itemId: string) => void;
  /** Hint text shown in the drop overlay when an item is dragged over. */
  dropHint?: string;
}
function DueColumn({ title, subtitle, count, tone, children, empty, onDropItem, dropHint }: DueColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const dropProps = onDropItem ? {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-pt-item')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragOver) setDragOver(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      // Only clear when leaving the column itself, not its children.
      if (e.currentTarget === e.target) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const id = e.dataTransfer.getData('application/x-pt-item');
      if (id) onDropItem(id);
    },
  } : {};
  return (
    <div className={'due-col due-col-' + tone + (dragOver ? ' due-col-dragover' : '')} {...dropProps}>
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
      {dragOver && dropHint && (
        <div className="due-col-drop-overlay">
          <div className="due-col-drop-hint">{dropHint}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline "Set due date" button — click pops the browser's native date picker
 * via input.showPicker(); on change we PATCH target_date and trigger a refresh
 * so the card relocates to the correct column automatically.
 */
function QuickDueDate({ item, onSaved }: { item: WorkItem; onSaved?: (date: string) => void }) {
  const { currentProjectId, workspaceSlug } = useDashboard();
  const projectId = item.project_id || currentProjectId;
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
    if (!date || !projectId) return;
    setSaving(true);
    setErr(null);
    try {
      await api.patchWorkItem(workspaceSlug!, projectId, item.id, { target_date: date });
      // Optimistic update via parent override map; the caller will sync
      // from Plane when they're done editing (avoids per-PATCH refresh
      // which would hit the 60/min rate limit).
      onSaved?.(date);
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
  /** Called after QuickDueDate successfully PATCHes a date (for optimistic local update). */
  onQuickDateSaved?: (itemId: string, date: string) => void;
}
function DueCard({ item, projIdent, meta, today, isMissing, onQuickDateSaved }: DueCardProps) {
  // In combined views each item carries its own project prefix; fall back to the active one.
  const prefix = item.project_identifier || projIdent;
  const url = planeItemUrl(item.seq, { id: '', identifier: prefix }, meta);
  const prio = PRIORITY_INFO[item.priority] || PRIORITY_INFO.none;
  const sinceUpdated = daysBetween(item.updated_at, today);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={'due-card' + (dragging ? ' due-card-dragging' : '')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pt-item', item.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      <div className="due-card-head">
        <span className={'badge ' + prioCls(item.priority)}>{prio.label}</span>
        <a href={url} target="_blank" rel="noopener" className="due-card-seq">{prefix}-{item.seq}</a>
        {isMissing
          ? <span className="ml-auto"><QuickDueDate item={item} onSaved={(date) => onQuickDateSaved?.(item.id, date)} /></span>
          : item.end
            ? <span className="ml-auto inline-flex items-center gap-1.5">
                <DueChangesPill item={item} />
                <span className="due-card-due">Due {fmtShortDate(item.end)}</span>
              </span>
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
      {item.labels && item.labels.length > 0 && (
        <div className="due-card-labels">
          {item.labels.map(l => (
            <span key={l.id} className="due-card-label" title={l.name}>
              <span className="due-card-label-dot" style={{ background: l.color || '#888780' }} />
              {l.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface PastDueBucket {
  key: 'wk1' | 'wk2' | 'wk34' | 'mo2';
  title: string;
  subtitle: string;
  items: WorkItem[];
}

interface PastDueStripProps {
  items: WorkItem[];
  projIdent: string;
  meta: { workspace_slug?: string } | undefined;
  today: string;
}
function PastDueStrip({ items, projIdent, meta, today }: PastDueStripProps) {
  const [expanded, setExpanded] = useState(false);

  const { buckets, withinCount, overflow } = useMemo(() => {
    const todayMs = new Date(today + 'T00:00:00Z').getTime();
    const bucks: PastDueBucket[] = [
      { key: 'wk1',  title: 'Due last week',      subtitle: '1–7 days overdue',   items: [] },
      { key: 'wk2',  title: 'The week before',    subtitle: '8–14 days overdue',  items: [] },
      { key: 'wk34', title: 'Earlier this month', subtitle: '15–28 days overdue', items: [] },
      { key: 'mo2',  title: 'Last month',         subtitle: '29–60 days overdue', items: [] },
    ];
    let within = 0;
    let over = 0;
    for (const it of items) {
      if (!it.end) continue;
      const days = Math.round((todayMs - new Date(it.end + 'T00:00:00Z').getTime()) / 86400000);
      if (days < 1) continue;
      if (days <= 7) { bucks[0].items.push(it); within++; }
      else if (days <= 14) { bucks[1].items.push(it); within++; }
      else if (days <= 28) { bucks[2].items.push(it); within++; }
      else if (days <= 60) { bucks[3].items.push(it); within++; }
      else over++;
    }
    return { buckets: bucks, withinCount: within, overflow: over };
  }, [items, today]);

  if (items.length === 0) return null;
  const oldestDays = items[0]?.end
    ? Math.max(0, Math.round((new Date(today + 'T00:00:00Z').getTime() - new Date(items[0].end + 'T00:00:00Z').getTime()) / 86400000))
    : 0;

  return (
    <div className={'pastdue-strip' + (expanded ? ' pastdue-strip-open' : '')}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="pastdue-strip-bar"
        aria-expanded={expanded}
      >
        <AlertTriangle className="h-3.5 w-3.5 pastdue-strip-icon" />
        <span className="pastdue-strip-count">{items.length}</span>
        <span className="pastdue-strip-title">item{items.length === 1 ? '' : 's'} missed due date{items.length === 1 ? '' : 's'}</span>
        {oldestDays > 0 && (
          <span className="pastdue-strip-meta">oldest <strong>{oldestDays}d</strong> overdue</span>
        )}
        <span className="pastdue-strip-chev">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="text-[11px]">{expanded ? 'Hide' : 'Expand'}</span>
        </span>
      </button>
      {expanded && (
        <div className="pastdue-strip-body">
          <div className="pastdue-cols">
            {buckets.map(b => (
              <div key={b.key} className="pastdue-col">
                <div className="pastdue-col-head">
                  <div className="pastdue-col-title">
                    <span className="pastdue-col-dot" />
                    <span>{b.title}</span>
                    <span className="pastdue-col-count">{b.items.length}</span>
                  </div>
                  <div className="pastdue-col-sub">{b.subtitle}</div>
                </div>
                <div className="pastdue-col-body">
                  {b.items.length === 0 ? (
                    <div className="pastdue-col-empty">None.</div>
                  ) : b.items.map(it => (
                    <DueCard key={it.id} item={it} projIdent={projIdent} meta={meta} today={today} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {(overflow > 0 || withinCount < items.length) && (
            <div className="pastdue-overflow">
              <strong>{overflow}</strong> item{overflow === 1 ? '' : 's'} overdue by more than 60 days — not shown here. Check the Action Center.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const sortByUrgency = (a: WorkItem, b: WorkItem) => {
  // Earlier due date first; same date → higher priority first.
  if (a.end && b.end && a.end !== b.end) return a.end < b.end ? -1 : 1;
  return (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
};

export function DueWorkView() {
  const { data, currentProject, currentProjectId, workspaceSlug, refresh, refreshing } = useDashboard();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [dropMsg, setDropMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Local optimistic overrides for items whose target_date we just PATCHed.
  // The cached `data` doesn't refresh per-drop (avoids hitting Plane's
  // 60/min rate limit), so we apply these client-side so the card relocates
  // immediately. Cleared when the user manually syncs (refresh).
  const [overrides, setOverrides] = useState<Map<string, string | null>>(new Map());

  // Options are built from the *unfiltered* item set so the user can still
  // see and toggle facets that the current filter would otherwise hide.
  const options = useMemo(() => (data ? buildOptions(data.items) : null), [data]);

  const itemsWithOverrides = useMemo(() => {
    if (!data) return [];
    if (overrides.size === 0) return data.items;
    return data.items.map(i => {
      if (!overrides.has(i.id)) return i;
      const newEnd = overrides.get(i.id);
      return { ...i, end: newEnd ?? undefined };
    });
  }, [data, overrides]);

  const filteredItems = useMemo(() => {
    const byFacets = applyFilters(itemsWithOverrides, filters);
    const q = search.trim().toLowerCase();
    if (!q) return byFacets;
    const ident = projectPrefix(currentProject).toLowerCase();
    return byFacets.filter(i =>
      i.name.toLowerCase().includes(q) ||
      String(i.seq).includes(q) ||
      `${ident}-${i.seq}`.includes(q),
    );
  }, [itemsWithOverrides, filters, search, currentProject]);

  const activeFilterCount =
    filters.state.size + filters.priority.size + filters.type.size + filters.assignee.size + filters.label.size;

  const buckets = useMemo(() => {
    if (!data) return null;
    const today = new Date(data.today + 'T00:00:00Z');
    const wkEnd1 = endOfThisWeekSat(today);
    const wkEnd2 = new Date(wkEnd1); wkEnd2.setUTCDate(wkEnd2.getUTCDate() + 7);
    const wkEnd3 = new Date(wkEnd2); wkEnd3.setUTCDate(wkEnd3.getUTCDate() + 7);

    const missing: WorkItem[] = [];
    const pastDue: WorkItem[] = [];
    const thisWeek: WorkItem[] = [];
    const nextWeek: WorkItem[] = [];
    const twoWeeks: WorkItem[] = [];

    for (const i of filteredItems) {
      const sg = i.state_group;
      const isClosed = sg === 'completed' || sg === 'cancelled';
      if (isClosed) continue;
      const isActive = sg === 'started' || sg === 'unstarted';
      if (!i.end) {
        if (isActive) missing.push(i);
        continue;
      }
      const due = new Date(i.end + 'T00:00:00Z');
      if (due < today) {
        pastDue.push(i);
        continue;
      }
      if (due <= wkEnd1) thisWeek.push(i);
      else if (due <= wkEnd2) nextWeek.push(i);
      else if (due <= wkEnd3) twoWeeks.push(i);
      // > 3 weeks out: not shown in this view
    }

    missing.sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0));
    pastDue.sort((a, b) => {
      // Most overdue first; ties broken by priority.
      if (a.end && b.end && a.end !== b.end) return a.end < b.end ? -1 : 1;
      return (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
    });
    thisWeek.sort(sortByUrgency);
    nextWeek.sort(sortByUrgency);
    twoWeeks.sort(sortByUrgency);

    // Friday targets for each dated column. Picked so dragging an item into
    // the column gives it a sensible default due date in the middle of that
    // week. If "this Friday" is already past (today is Sat), bump to today.
    const friOf = (sat: Date) => {
      const fri = new Date(sat);
      fri.setUTCDate(fri.getUTCDate() - 1);
      return fri;
    };
    const friThis = friOf(wkEnd1);
    const friNext = friOf(wkEnd2);
    const friTwo  = friOf(wkEnd3);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    return {
      missing, pastDue, thisWeek, nextWeek, twoWeeks,
      labels: {
        thisWeek: `today → Sat ${fmtRange(wkEnd1)}`,
        nextWeek: `${fmtRange(new Date(wkEnd1.getTime() + 86400000))} → Sat ${fmtRange(wkEnd2)}`,
        twoWeeks: `${fmtRange(new Date(wkEnd2.getTime() + 86400000))} → Sat ${fmtRange(wkEnd3)}`,
      },
      targets: {
        thisWeek: iso(friThis < today ? today : friThis),
        nextWeek: iso(friNext),
        twoWeeks: iso(friTwo),
      },
      targetsLabel: {
        thisWeek: (friThis < today ? today : friThis).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
        nextWeek: friNext.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
        twoWeeks: friTwo.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      },
    };
  }, [data, filteredItems]);

  if (!data || !buckets) return <div className="text-sm text-muted-foreground p-4">No data.</div>;
  const projIdent = projectPrefix(currentProject);
  const meta = data._meta;
  const today = data.today;

  const applyOverride = (itemId: string, newEnd: string | null) => {
    setOverrides(prev => {
      const next = new Map(prev);
      next.set(itemId, newEnd);
      return next;
    });
  };
  const card = (it: WorkItem) => (
    <DueCard key={it.id} item={it} projIdent={projIdent} meta={meta} today={today} />
  );
  const missingCard = (it: WorkItem) => (
    <DueCard
      key={it.id}
      item={it}
      projIdent={projIdent}
      meta={meta}
      today={today}
      isMissing
      onQuickDateSaved={(id, date) => applyOverride(id, date)}
    />
  );

  const handleDrop = async (itemId: string, targetDate: string | null) => {
    const current = itemsWithOverrides.find(i => i.id === itemId);
    if (!current) return;
    const projectId = current.project_id || currentProjectId;
    if (!projectId) return;
    // No-op if the drop wouldn't change anything.
    if ((current.end || null) === targetDate) return;
    setDropMsg(null);
    try {
      await api.patchWorkItem(workspaceSlug!, projectId, itemId, { target_date: targetDate });
      // Apply optimistic override so the card relocates without a full
      // refresh (which would cost ~12 Plane API calls per drop and hit
      // the 60/min rate limit after a few drags).
      setOverrides(prev => {
        const next = new Map(prev);
        next.set(itemId, targetDate);
        return next;
      });
    } catch (e) {
      setDropMsg({ kind: 'err', text: `Failed to update ${projIdent}-${current.seq}: ${(e as Error).message}` });
    }
  };

  const syncFromPlane = async () => {
    setDropMsg(null);
    try {
      await refresh();
      setOverrides(new Map());
    } catch (e) {
      setDropMsg({ kind: 'err', text: `Sync failed: ${(e as Error).message}` });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this board by ID or title…"
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          aria-label="Search Due Work by ID or title"
        />
        {search && (
          <>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {filteredItems.length} match{filteredItems.length === 1 ? '' : 'es'}
            </span>
            <button
              type="button"
              onClick={() => setSearch('')}
              className="inline-flex items-center text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      <PastDueStrip items={buckets.pastDue} projIdent={projIdent} meta={meta} today={today} />

      {options && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card">
          <span className="text-xs text-muted-foreground font-medium mr-1">Filter:</span>
          <MultiSelectChip
            label="State"
            options={options.stateOpts}
            selected={filters.state}
            onChange={s => setFilters(f => ({ ...f, state: s }))}
          />
          <MultiSelectChip
            label="Priority"
            options={options.prioOpts}
            selected={filters.priority}
            onChange={s => setFilters(f => ({ ...f, priority: s }))}
          />
          <MultiSelectChip
            label="Type"
            options={options.typeOpts}
            selected={filters.type}
            onChange={s => setFilters(f => ({ ...f, type: s }))}
          />
          <MultiSelectChip
            label="Assignee"
            options={options.assigneeOpts}
            selected={filters.assignee}
            onChange={s => setFilters(f => ({ ...f, assignee: s }))}
          />
          <MultiSelectChip
            label="Label"
            options={options.labelOpts}
            selected={filters.label}
            onChange={s => setFilters(f => ({ ...f, label: s }))}
            hideWhenEmpty
          />
          <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
            {activeFilterCount > 0
              ? `${filteredItems.length} of ${data.items.length} items`
              : `${data.items.length} items`}
          </span>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />Clear
            </button>
          )}
        </div>
      )}

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

      {(overrides.size > 0 || dropMsg) && (
        <div className={'flex items-center gap-3 px-3 py-2 rounded-md text-[12px] ' +
          (dropMsg?.kind === 'err'
            ? 'text-red-700 dark:text-red-400 bg-red-500/10'
            : 'text-foreground bg-accent/40 border border-border')}>
          {dropMsg?.kind === 'err' ? (
            <span className="flex-1">{dropMsg.text}</span>
          ) : (
            <span className="flex-1">
              <strong>{overrides.size}</strong> due date{overrides.size === 1 ? '' : 's'} saved to Plane.
              <span className="text-muted-foreground"> Card{overrides.size === 1 ? '' : 's'} moved locally; sync to refresh aggregates.</span>
            </span>
          )}
          {overrides.size > 0 && (
            <button
              type="button"
              onClick={syncFromPlane}
              disabled={refreshing}
              className="px-3 h-7 rounded-md bg-foreground text-background text-[11.5px] hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
            >
              {refreshing ? 'Syncing…' : 'Sync from Plane'}
            </button>
          )}
        </div>
      )}

      <div className="due-board">
        <DueColumn
          title="Missing due date"
          subtitle="click + on a card to set one"
          tone="neutral"
          count={buckets.missing.length}
          empty="All active items have due dates."
          onDropItem={(id) => handleDrop(id, null)}
          dropHint="Drop to clear due date"
        >
          {buckets.missing.map(missingCard)}
        </DueColumn>
        <DueColumn
          title="Due this week"
          subtitle={buckets.labels.thisWeek}
          tone="bad"
          count={buckets.thisWeek.length}
          empty="Nothing due this week."
          onDropItem={(id) => handleDrop(id, buckets.targets.thisWeek)}
          dropHint={`Drop to set due → ${buckets.targetsLabel.thisWeek}`}
        >
          {buckets.thisWeek.map(card)}
        </DueColumn>
        <DueColumn
          title="Due next week"
          subtitle={buckets.labels.nextWeek}
          tone="warm"
          count={buckets.nextWeek.length}
          empty="Nothing due next week."
          onDropItem={(id) => handleDrop(id, buckets.targets.nextWeek)}
          dropHint={`Drop to set due → ${buckets.targetsLabel.nextWeek}`}
        >
          {buckets.nextWeek.map(card)}
        </DueColumn>
        <DueColumn
          title="Due in 2 weeks"
          subtitle={buckets.labels.twoWeeks}
          tone="cool"
          count={buckets.twoWeeks.length}
          empty="Nothing due in 2 weeks."
          onDropItem={(id) => handleDrop(id, buckets.targets.twoWeeks)}
          dropHint={`Drop to set due → ${buckets.targetsLabel.twoWeeks}`}
        >
          {buckets.twoWeeks.map(card)}
        </DueColumn>
      </div>
    </div>
  );
}
