/**
 * Gantt-style roadmap for the Pulse tab.
 *
 * Pick a work-item type → each item of that type becomes a row, with its
 * direct children indented underneath.
 *
 * Layout: a wide horizontal timeline (~-6mo to +12mo around today). The user
 * scrolls horizontally to pan. The left meta columns (name / state / priority
 * / assignee) are position:sticky so they stay visible while panning. The
 * Week / Month / Quarter scale toggle controls px-per-day density. The Today
 * button scrolls the viewport to center on today.
 *
 * Editing:
 *   - Click a bar (or 'add dates' pip) → inline date popover anchored below it.
 *   - Drag a bar body → shift both dates by N days.
 *   - Drag the left / right edge of a bar → resize start / end.
 *   - All changes are STAGED locally (pendingEdits) so the bar reflects the
 *     proposed plan live. A single 'Update N' button at the top batch-PATCHes
 *     everything to Plane and refreshes data.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import interact from 'interactjs';
import { ChevronDown, ChevronUp, ChevronRight, X, AlertTriangle, Filter as FilterIcon, Maximize2, Minimize2, ChevronsUpDown, Search, Hand, MoveHorizontal } from 'lucide-react';
import type { StateGroup, WorkItem } from '@/lib/types';
import { useDashboard } from '@/lib/dashboard-context';
import { PRIORITY_INFO } from '@/lib/constants';
import { api } from '@/lib/api';
import { EditModal } from './EditWorkItem';

type Scale = 'week' | 'month' | 'quarter';
const SCALES: Array<{ key: Scale; label: string; pxPerDay: number }> = [
  { key: 'week',    label: 'Week',    pxPerDay: 48 },
  { key: 'month',   label: 'Month',   pxPerDay: 14 },
  { key: 'quarter', label: 'Quarter', pxPerDay: 5 },
];

const MIN_DURATION_DAYS = 1;
// Minimum rendered bar width. Short (1–3 day) items at Month/Quarter zoom would
// otherwise be a few pixels wide. We clamp the visual width so the two edge
// resize handles and the centre move grip all fit without overlapping.
const MIN_BAR_PX = 44;

interface PendingEdit {
  start?: string | null;
  end?: string | null;
}
interface Row {
  item: WorkItem;
  depth: 0 | 1;
  childCount?: number;
}
interface Range {
  startMs: number;
  endMs: number;
  totalDays: number;
  totalPx: number;
  pxPerDay: number;
  ticks: Array<{ label: string; xPx: number; major?: boolean; dim?: boolean }>;
}

const DAY_MS = 86_400_000;

function isoFromMs(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function toUtcMidnight(iso: string): number {
  const s = iso.length === 10 ? iso + 'T00:00:00Z' : iso;
  return new Date(s).getTime();
}
function fmtDayMonth(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join('').toUpperCase() || '?';
}

function getRange(scale: Scale, todayIso: string): Range {
  const today = new Date(todayIso + 'T00:00:00Z');
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const rangeStart = new Date(thisMonth);
  rangeStart.setUTCMonth(rangeStart.getUTCMonth() - 6);
  const rangeEnd = new Date(thisMonth);
  rangeEnd.setUTCMonth(rangeEnd.getUTCMonth() + 13);
  rangeEnd.setUTCDate(0); // last day of (thisMonth + 12)
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime() + DAY_MS - 1;
  const totalDays = Math.round((endMs - startMs) / DAY_MS);
  const pxPerDay = SCALES.find(s => s.key === scale)!.pxPerDay;
  const totalPx = totalDays * pxPerDay;

  const ticks: Range['ticks'] = [];
  if (scale === 'quarter' || scale === 'month') {
    // Month-start ticks for both, but month gets weekly minor ticks too.
    const cur = new Date(rangeStart);
    while (cur.getTime() <= rangeEnd.getTime()) {
      const xPx = ((cur.getTime() - startMs) / DAY_MS) * pxPerDay;
      ticks.push({
        label: cur.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
          + (cur.getUTCMonth() === 0 ? ' ' + String(cur.getUTCFullYear()).slice(2) : ''),
        xPx,
        major: true,
      });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    if (scale === 'month') {
      // Add weekly Monday labels.
      const w = new Date(rangeStart);
      const dow = w.getUTCDay();
      const off = dow === 0 ? -6 : 1 - dow;
      w.setUTCDate(w.getUTCDate() + off);
      while (w.getTime() <= rangeEnd.getTime()) {
        const t = w.getTime();
        if (t >= startMs && w.getUTCDate() !== 1) {
          ticks.push({
            label: String(w.getUTCDate()),
            xPx: ((t - startMs) / DAY_MS) * pxPerDay,
          });
        }
        w.setUTCDate(w.getUTCDate() + 7);
      }
    }
  } else {
    // Week scale: one tick per day, with weekends dimmed.
    const cur = new Date(rangeStart);
    while (cur.getTime() <= rangeEnd.getTime()) {
      const t = cur.getTime();
      const dow = cur.getUTCDay();
      const major = cur.getUTCDate() === 1;
      ticks.push({
        label: cur.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2)
          + ' ' + cur.getUTCDate(),
        xPx: ((t - startMs) / DAY_MS) * pxPerDay,
        dim: dow === 0 || dow === 6,
        major,
      });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return { startMs, endMs, totalDays, totalPx, pxPerDay, ticks };
}

export function RoadmapTimeline() {
  const { data, currentProjectId, workspaceSlug, currentProject, refresh } = useDashboard();
  const projectIdent = currentProject?.identifier || '';
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [scale, setScale] = useState<Scale>('month');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [pendingEdits, setPendingEdits] = useState<Map<string, PendingEdit>>(new Map());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showUnresolved, setShowUnresolved] = useState(true);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((parentId: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [colWidths, setColWidths] = useState({ id: 70, name: 220, state: 96, priority: 78, assignee: 36 });
  type SortKey = 'id' | 'name' | 'state' | 'priority' | 'assignee';
  const [sort, setSort] = useState<{ key: SortKey | null; dir: 'asc' | 'desc' }>({ key: null, dir: 'asc' });
  const cycleSort = (key: SortKey) => {
    setSort(prev => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return { key: null, dir: 'asc' };
    });
  };
  const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  const COL_MIN = { id: 48, name: 100, state: 60, priority: 60, assignee: 32 } as const;
  const LABEL_PAD_GAPS = 60; // .roadmap-label padding 0 10px (20) + 4 gaps × 10 (40)
  const labelW = colWidths.id + colWidths.name + colWidths.state + colWidths.priority + colWidths.assignee + LABEL_PAD_GAPS;

  const startColResize = (col: keyof typeof colWidths, e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[col];
    const min = COL_MIN[col];
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(min, startW + (ev.clientX - startX));
      setColWidths(prev => prev[col] === next ? prev : { ...prev, [col]: next });
    };
    const onUp = (ev: PointerEvent) => {
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };
  const scrollRef = useRef<HTMLDivElement>(null);

  const typeOptions = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.type_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [data]);
  const effectiveType = selectedType ?? typeOptions[0]?.name ?? null;

  const range = useMemo(() => data ? getRange(scale, data.today) : null, [scale, data]);

  const effectiveDates = useCallback((item: WorkItem) => {
    const p = pendingEdits.get(item.id);
    return {
      start: p && 'start' in p ? p.start ?? null : (item.start ?? null),
      end:   p && 'end'   in p ? p.end   ?? null : (item.end   ?? null),
    };
  }, [pendingEdits]);

  const isResolved = (it: WorkItem) => it.state_group === 'completed' || it.state_group === 'cancelled';
  const passesStatusFilter = useCallback((it: WorkItem) => {
    const resolved = isResolved(it);
    return resolved ? showResolved : showUnresolved;
  }, [showResolved, showUnresolved]);

  const searchActive = search.trim().length > 0;
  const formatId = useCallback((seq: number | undefined): string => {
    if (seq === undefined || seq === null) return '';
    return projectIdent ? `${projectIdent}-${seq}` : String(seq);
  }, [projectIdent]);
  const matchesSearch = useCallback((it: WorkItem) => {
    if (!searchActive) return true;
    const q = search.trim().toLowerCase();
    const prioLabel = PRIORITY_INFO[it.priority]?.label || '';
    return (
      it.name.toLowerCase().includes(q) ||
      it.state.toLowerCase().includes(q) ||
      it.priority.toLowerCase().includes(q) ||
      prioLabel.toLowerCase().includes(q) ||
      String(it.seq).includes(q) ||
      formatId(it.seq).toLowerCase().includes(q)
    );
  }, [search, searchActive, formatId]);

  const rows = useMemo<Row[]>(() => {
    if (!data || !effectiveType) return [];
    const byId = new Map(data.items.map(i => [i.id, i]));
    const childrenOf = new Map<string, WorkItem[]>();
    for (const i of data.items) {
      if (i.parent && byId.has(i.parent)) {
        const arr = childrenOf.get(i.parent) ?? [];
        arr.push(i);
        childrenOf.set(i.parent, arr);
      }
    }
    // Sort by the item's PERSISTED dates, not staged ones — otherwise dragging a
    // bar changes its sort key and the row jumps mid-edit. The list re-sorts only
    // after edits are pushed and data reloads.
    const dateKey = (it: WorkItem) => it.start || it.end || '9999';
    const assigneeName = (it: WorkItem) => {
      const aid = it.assignee_id;
      return (aid && (data.users[aid] || it.assignee)) || it.assignee || '';
    };
    const cmp = (a: WorkItem, b: WorkItem): number => {
      if (!sort.key) return dateKey(a).localeCompare(dateKey(b));
      const dir = sort.dir === 'asc' ? 1 : -1;
      switch (sort.key) {
        case 'id':       return dir * ((a.seq ?? 0) - (b.seq ?? 0));
        case 'name':     return dir * a.name.localeCompare(b.name);
        case 'state':    return dir * a.state.localeCompare(b.state);
        case 'priority': return dir * ((PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
        case 'assignee': return dir * assigneeName(a).localeCompare(assigneeName(b));
      }
    };
    if (searchActive) {
      // Flat list when searching: ignore parent grouping, hit any matching item.
      return data.items
        .filter(i => i.type === effectiveType && passesStatusFilter(i) && matchesSearch(i))
        .sort(cmp)
        .map(item => ({ item, depth: 0 as const }));
    }
    const parents = data.items
      .filter(i => i.type === effectiveType && passesStatusFilter(i))
      .sort(cmp);
    const out: Row[] = [];
    const seen = new Set<string>();
    const pushRow = (r: Row) => {
      if (seen.has(r.item.id)) return;
      seen.add(r.item.id);
      out.push(r);
    };
    for (const p of parents) {
      const kids = (childrenOf.get(p.id) ?? [])
        .filter(passesStatusFilter)
        .slice()
        .sort(cmp);
      pushRow({ item: p, depth: 0, childCount: kids.length });
      if (!expandedParents.has(p.id)) continue;
      for (const k of kids) pushRow({ item: k, depth: 1 });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, effectiveType, passesStatusFilter, expandedParents, sort, searchActive, matchesSearch]);

  const scrollToToday = useCallback(() => {
    if (!scrollRef.current || !range || !data) return;
    const todayMs = toUtcMidnight(data.today);
    const todayPx = ((todayMs - range.startMs) / DAY_MS) * range.pxPerDay;
    const viewport = scrollRef.current.clientWidth;
    // Leave the sticky label column in view; scroll so today sits ~1/3 across.
    const target = Math.max(0, todayPx - viewport / 3);
    scrollRef.current.scrollLeft = target;
  }, [range, data]);

  // Scroll to today on mount and whenever scale changes (px-per-day shifts).
  useLayoutEffect(() => { scrollToToday(); }, [scrollToToday]);

  // Re-center on today when entering/leaving fullscreen (viewport width changes).
  useLayoutEffect(() => { scrollToToday(); }, [fullscreen, scrollToToday]);

  // Esc exits fullscreen; lock body scroll while expanded.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  if (!data || !range) return null;

  const todayMs = toUtcMidnight(data.today);
  const todayInRange = todayMs >= range.startMs && todayMs <= range.endMs;
  const todayPx = todayInRange ? ((todayMs - range.startMs) / DAY_MS) * range.pxPerDay : null;

  const stageEdit = (id: string, patch: PendingEdit) => {
    setPendingEdits(prev => {
      const next = new Map(prev);
      const existing = next.get(id) ?? {};
      next.set(id, { ...existing, ...patch });
      return next;
    });
  };
  const clearEditForItem = (id: string) => {
    setPendingEdits(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };
  const discardAll = () => { setPendingEdits(new Map()); setMsg(null); };

  const pushAll = async () => {
    if (!currentProjectId || pendingEdits.size === 0) return;
    setSaving(true);
    setMsg(null);
    const failures: string[] = [];
    for (const [itemId, edit] of pendingEdits) {
      const patch: Record<string, unknown> = {};
      if ('start' in edit) patch.start_date = edit.start ?? null;
      if ('end'   in edit) patch.target_date = edit.end ?? null;
      if (Object.keys(patch).length === 0) continue;
      try {
        await api.patchWorkItem(workspaceSlug!, currentProjectId, itemId, patch);
      } catch (e) {
        failures.push(`${itemId.slice(0, 6)}: ${(e as Error).message}`);
      }
    }
    if (failures.length === 0) {
      setMsg({ kind: 'ok', text: `Updated ${pendingEdits.size} item${pendingEdits.size === 1 ? '' : 's'}. Refreshing…` });
      setPendingEdits(new Map());
      await refresh();
    } else {
      setMsg({ kind: 'err', text: `Some updates failed: ${failures.join('; ')}` });
    }
    setSaving(false);
  };

  const pendingCount = pendingEdits.size;

  return (
    <section className={'chart-box' + (fullscreen ? ' roadmap-fullscreen' : '')}>
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div>
          <h3>Roadmap timeline <span className="approx">· {SCALES.find(s => s.key === scale)?.label} zoom ({rows.length})</span></h3>
          <div className="text-[11px] text-muted-foreground">
            {pendingCount === 0
              ? 'Click bar → edit dates · Drag bar → move · Drag edges → resize'
              : <><strong className="text-foreground">{pendingCount}</strong> change{pendingCount === 1 ? '' : 's'} staged — review and push when ready</>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {pendingCount > 0 && (
            <>
              <button
                type="button"
                onClick={discardAll}
                disabled={saving}
                className="px-2.5 h-7 rounded-md border border-border bg-card text-xs text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={pushAll}
                disabled={saving}
                className="px-3 h-7 rounded-md bg-foreground text-background text-xs hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Updating…' : `Update ${pendingCount}`}
              </button>
            </>
          )}
          <div className="roadmap-search">
            <Search className="roadmap-search-icon" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, state, priority…"
              aria-label="Search work items"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="roadmap-search-clear"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <FilterMenu
            open={filterMenuOpen}
            setOpen={setFilterMenuOpen}
            showResolved={showResolved}
            showUnresolved={showUnresolved}
            setShowResolved={setShowResolved}
            setShowUnresolved={setShowUnresolved}
            onExpandAll={() => {
              if (!data) return;
              const all = new Set<string>();
              const types = new Set([effectiveType]);
              for (const i of data.items) {
                if (types.has(i.type)) all.add(i.id);
              }
              setExpandedParents(all);
            }}
            onCollapseAll={() => setExpandedParents(new Set())}
          />
          <div className="roadmap-scale">
            {SCALES.map(s => (
              <button
                key={s.key}
                type="button"
                onClick={() => setScale(s.key)}
                className={'roadmap-scale-btn' + (scale === s.key ? ' active' : '')}
              >
                {s.label}
              </button>
            ))}
            <button
              type="button"
              onClick={scrollToToday}
              className="roadmap-scale-btn"
              title="Scroll to today"
            >
              Today
            </button>
          </div>
          <TypePicker
            options={typeOptions}
            value={effectiveType}
            open={typeMenuOpen}
            setOpen={setTypeMenuOpen}
            onChange={(name) => { setSelectedType(name); setTypeMenuOpen(false); }}
          />
          <button
            type="button"
            onClick={() => setFullscreen(v => !v)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent"
            title={fullscreen ? 'Exit full screen (Esc)' : 'Expand to full screen'}
            aria-label={fullscreen ? 'Exit full screen' : 'Expand to full screen'}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {msg && (
        <div className={'mb-2 px-2.5 py-1.5 rounded-md text-[11.5px] ' +
          (msg.kind === 'ok' ? 'text-green-700 dark:text-green-400 bg-green-500/10' : 'text-red-700 dark:text-red-400 bg-red-500/10')}>
          {msg.text}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground px-1 py-4">
          No {effectiveType ?? 'matching'} items.
        </div>
      ) : (
        <div className="roadmap-scroll" ref={scrollRef}>
          <div
            className="roadmap"
            style={{
              '--roadmap-timeline-w': `${range.totalPx}px`,
              '--roadmap-label-w': `${labelW}px`,
              '--col-id': `${colWidths.id}px`,
              '--col-name': `${colWidths.name}px`,
              '--col-state': `${colWidths.state}px`,
              '--col-priority': `${colWidths.priority}px`,
              '--col-assignee': `${colWidths.assignee}px`,
            } as React.CSSProperties}
          >
            {/* Header row: meta column titles + time ticks */}
            <div className="roadmap-row roadmap-header">
              <div className="roadmap-label roadmap-label-head">
                <span className="roadmap-meta-id">
                  <button type="button" className="roadmap-sort-btn" onClick={() => cycleSort('id')}>
                    ID<SortArrow active={sort.key === 'id'} dir={sort.dir} />
                  </button>
                  <span className="roadmap-col-resize" onPointerDown={(e) => startColResize('id', e)} aria-label="Resize ID column" />
                </span>
                <span className="roadmap-meta-name">
                  <button type="button" className="roadmap-sort-btn" onClick={() => cycleSort('name')}>
                    Work item<SortArrow active={sort.key === 'name'} dir={sort.dir} />
                  </button>
                  <span className="roadmap-col-resize" onPointerDown={(e) => startColResize('name', e)} aria-label="Resize work item column" />
                </span>
                <span className="roadmap-meta-state">
                  <button type="button" className="roadmap-sort-btn" onClick={() => cycleSort('state')}>
                    State<SortArrow active={sort.key === 'state'} dir={sort.dir} />
                  </button>
                  <span className="roadmap-col-resize" onPointerDown={(e) => startColResize('state', e)} aria-label="Resize state column" />
                </span>
                <span className="roadmap-meta-priority">
                  <button type="button" className="roadmap-sort-btn" onClick={() => cycleSort('priority')}>
                    Priority<SortArrow active={sort.key === 'priority'} dir={sort.dir} />
                  </button>
                  <span className="roadmap-col-resize" onPointerDown={(e) => startColResize('priority', e)} aria-label="Resize priority column" />
                </span>
                <span className="roadmap-meta-assignee">
                  <button type="button" className="roadmap-sort-btn roadmap-sort-btn-icon" onClick={() => cycleSort('assignee')} title="Sort by assignee">
                    <SortArrow active={sort.key === 'assignee'} dir={sort.dir} />
                  </button>
                  <span className="roadmap-col-resize" onPointerDown={(e) => startColResize('assignee', e)} aria-label="Resize assignee column" />
                </span>
              </div>
              <div className="roadmap-track">
                {range.ticks.map((t, i) => (
                  <div
                    key={i}
                    className={'roadmap-tick' + (t.dim ? ' roadmap-tick-dim' : '') + (t.major ? ' roadmap-tick-major' : '')}
                    style={{ left: `${t.xPx}px` }}
                  >
                    {t.label}
                  </div>
                ))}
              </div>
            </div>

            {/* Body rows */}
            <div className="roadmap-body">
              {todayPx !== null && (
                <div className="roadmap-today" style={{ left: `calc(var(--roadmap-label-w) + ${todayPx}px)` }}>
                  <div className="roadmap-today-line" />
                  <div className="roadmap-today-label">today · {fmtDayMonth(data.today)}</div>
                </div>
              )}
              {rows.map(({ item, depth, childCount }) => {
                const eff = effectiveDates(item);
                const stateColor = data.state_group_info[item.state_group as StateGroup]?.color || '#888780';
                const isDirty = pendingEdits.has(item.id);
                const hasChildren = depth === 0 && (childCount ?? 0) > 0;
                return (
                  <RoadmapRow
                    key={item.id}
                    item={item}
                    depth={depth}
                    start={eff.start}
                    end={eff.end}
                    isDirty={isDirty}
                    range={range}
                    stateColor={stateColor}
                    userColors={data.user_colors || {}}
                    users={data.users || {}}
                    today={data.today}
                    displayId={formatId(item.seq)}
                    hasChildren={hasChildren}
                    childCount={childCount ?? 0}
                    expanded={expandedParents.has(item.id)}
                    onToggleExpand={() => toggleExpand(item.id)}
                    isEditing={editingId === item.id}
                    onOpenEdit={() => setEditingId(prev => prev === item.id ? null : item.id)}
                    onCloseEdit={() => setEditingId(null)}
                    onStage={(patch) => stageEdit(item.id, patch)}
                    onRevert={() => clearEditForItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="roadmap-legend">
        {(['started', 'unstarted', 'backlog', 'completed', 'cancelled'] as StateGroup[]).map(g => {
          const info = data.state_group_info[g];
          if (!info) return null;
          return (
            <span key={g} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: info.color }} />
              {info.label}
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-sm border" style={{ borderColor: PRIORITY_INFO.urgent.color }} />
          Urgent priority
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="inline-block w-3 h-[2px]" style={{ background: '#A32D2D' }} />
          Today
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-sm border-2" style={{ borderColor: 'var(--ring)' }} />
          Staged change
        </span>
      </div>
    </section>
  );
}

function SortArrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <ChevronsUpDown className="roadmap-sort-icon roadmap-sort-icon-dim" />;
  return dir === 'asc'
    ? <ChevronUp className="roadmap-sort-icon" />
    : <ChevronDown className="roadmap-sort-icon" />;
}

function FilterMenu({
  open, setOpen, showResolved, showUnresolved,
  setShowResolved, setShowUnresolved, onExpandAll, onCollapseAll,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
  showResolved: boolean;
  showUnresolved: boolean;
  setShowResolved: (v: boolean) => void;
  setShowUnresolved: (v: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const activeCount =
    (!showResolved ? 1 : 0) + (!showUnresolved ? 1 : 0);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md border border-border bg-card text-xs hover:bg-accent"
        title="Filter"
      >
        <FilterIcon className="h-3.5 w-3.5 opacity-80" />
        <span>Filter</span>
        {activeCount > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-foreground text-background text-[10px] leading-none">
            {activeCount}
          </span>
        )}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 right-0 top-full mt-1 min-w-[220px] bg-card border border-border rounded-md shadow-lg p-1">
            <label className="roadmap-filter-item">
              <input
                type="checkbox"
                checked={showUnresolved}
                onChange={(e) => setShowUnresolved(e.target.checked)}
              />
              <span>Unresolved</span>
            </label>
            <label className="roadmap-filter-item">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />
              <span>Resolved</span>
            </label>
            <div className="roadmap-filter-sep" />
            <button
              type="button"
              onClick={() => { onExpandAll(); setOpen(false); }}
              className="roadmap-filter-action"
            >
              Expand all sub-work items
            </button>
            <button
              type="button"
              onClick={() => { onCollapseAll(); setOpen(false); }}
              className="roadmap-filter-action"
            >
              Collapse all sub-work items
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TypePicker({
  options, value, open, setOpen, onChange,
}: {
  options: Array<{ name: string; count: number }>;
  value: string | null;
  open: boolean;
  setOpen: (o: boolean) => void;
  onChange: (name: string) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md border border-border bg-card text-xs hover:bg-accent"
      >
        <span className="text-muted-foreground">Type:</span>
        <span className="font-medium">{value || '—'}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 right-0 top-full mt-1 min-w-[180px] bg-card border border-border rounded-md shadow-lg p-1">
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No types</div>
            ) : options.map(o => {
              const active = o.name === value;
              return (
                <button
                  key={o.name}
                  type="button"
                  onClick={() => onChange(o.name)}
                  className={'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-accent ' +
                    (active ? 'text-foreground bg-accent/50' : 'text-muted-foreground')}
                >
                  <span>{o.name}</span>
                  <span className="text-[10.5px] text-muted-foreground">{o.count}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Row + bar + drag ----------

type DragMode = 'move' | 'resize-start' | 'resize-end';

function RoadmapRow({
  item, depth, start, end, isDirty, range, stateColor, userColors, users, today,
  displayId, hasChildren, childCount, expanded, onToggleExpand,
  isEditing, onOpenEdit, onCloseEdit, onStage, onRevert,
}: {
  item: WorkItem;
  depth: 0 | 1;
  start: string | null;
  end: string | null;
  isDirty: boolean;
  range: Range;
  stateColor: string;
  userColors: Record<string, string>;
  users: Record<string, string>;
  today: string;
  displayId: string;
  hasChildren: boolean;
  childCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
  isEditing: boolean;
  onOpenEdit: () => void;
  onCloseEdit: () => void;
  onStage: (patch: PendingEdit) => void;
  onRevert: () => void;
}) {
  const barRef = useRef<HTMLButtonElement | null>(null);
  const priorityInfo = PRIORITY_INFO[item.priority];
  const [detailOpen, setDetailOpen] = useState(false);

  // Overdue: end is set, in the past, and the item is still open.
  const isOpenState = item.state_group !== 'completed' && item.state_group !== 'cancelled';
  const isOverdue = !!end && end < today && isOpenState;
  const daysOverdue = isOverdue
    ? Math.max(0, Math.round((toUtcMidnight(today) - toUtcMidnight(end!)) / DAY_MS))
    : 0;
  // Plain-language reason for the ⚠ flag, shown in a hover tooltip so the user
  // knows exactly why it's there.
  const overdueReason = isOverdue
    ? {
        title: `Overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}`,
        detail: `The target date (${fmtDayMonth(end!)}) has passed, but this work item is still “${item.state}”. Move the target date out or progress the work to clear the flag.`,
      }
    : null;
  // Anchor (viewport coords) for the overdue tooltip while hovered; null = hidden.
  const [overdueTip, setOverdueTip] = useState<{ x: number; y: number } | null>(null);

  const assigneeId = item.assignee_id;
  const assigneeName = assigneeId ? (users[assigneeId] || item.assignee || '') : '';
  const assigneeColor = assigneeId ? (userColors[assigneeId] || item.assignee_color || '#888780') : '#888780';
  const extraAssignees = (item.assignee_ids?.length ?? 0) - (assigneeId ? 1 : 0);

  // Bar geometry. Items with BOTH dates render a full draggable bar. Items with a
  // SINGLE date render a small "partial" bar anchored on the known date: dragging
  // the open edge sets the missing date (creating a range), dragging the middle
  // moves the date. Items with no dates fall through to the row-click placeholder.
  const hasStart = !!start;
  const hasEnd = !!end;
  const hasAnyDate = hasStart || hasEnd;
  const isPartial = hasAnyDate && !(hasStart && hasEnd);
  // For drag math a single-date item is treated as a zero-length span on its date.
  const anchorStartMs = start ? toUtcMidnight(start) : (end ? toUtcMidnight(end) : null);
  const anchorEndMs   = end   ? toUtcMidnight(end)   : (start ? toUtcMidnight(start) : null);

  // ----- drag/resize via interact.js -----
  // `drag` holds the in-progress preview (pixel delta + which gesture); the bar
  // renders its geometry from it. interact.js owns all the pointer mechanics:
  // resize is bound to the two edge-handle elements, move to the centre hand grip.
  const [drag, setDrag] = useState<null | {
    mode: DragMode;
    origStartMs: number;
    origEndMs: number;
    deltaPx: number;
  }>(null);

  // Latest geometry/callbacks for the interact listeners, read through a ref so the
  // interactable is bound once and never goes stale as dates/zoom change.
  const live = useRef({ hasStart, hasEnd, anchorStartMs, anchorEndMs, pxPerDay: range.pxPerDay, onStage, onOpenEdit });
  live.current = { hasStart, hasEnd, anchorStartMs, anchorEndMs, pxPerDay: range.pxPerDay, onStage, onOpenEdit };

  useEffect(() => {
    const el = barRef.current;
    if (!el || !hasAnyDate) return;
    let acc = 0; // accumulated pixel delta for the active gesture

    const commit = (rawMode: DragMode) => {
      const L = live.current;
      setDrag(null);
      if (L.anchorStartMs === null || L.anchorEndMs === null) return;
      const days = Math.round(acc / L.pxPerDay);
      if (days === 0) return;
      // Single-date item: the edge on the known date just moves it; the open edge
      // extends into a range.
      let mode = rawMode;
      if (mode === 'resize-start' && L.hasStart && !L.hasEnd) mode = 'move';
      if (mode === 'resize-end' && L.hasEnd && !L.hasStart) mode = 'move';
      const delta = days * DAY_MS;
      let ns = L.anchorStartMs;
      let ne = L.anchorEndMs;
      if (mode === 'move') { ns += delta; ne += delta; }
      else if (mode === 'resize-start') ns = Math.min(L.anchorStartMs + delta, L.anchorEndMs - MIN_DURATION_DAYS * DAY_MS);
      else ne = Math.max(L.anchorEndMs + delta, L.anchorStartMs + MIN_DURATION_DAYS * DAY_MS);
      const activeStart = L.hasStart || mode === 'resize-start';
      const activeEnd   = L.hasEnd   || mode === 'resize-end';
      L.onStage({ start: activeStart ? isoFromMs(ns) : null, end: activeEnd ? isoFromMs(ne) : null });
    };
    const preview = (mode: DragMode) => {
      const L = live.current;
      if (L.anchorStartMs === null || L.anchorEndMs === null) return;
      setDrag({ mode, origStartMs: L.anchorStartMs, origEndMs: L.anchorEndMs, deltaPx: acc });
    };

    const ix = interact(el)
      .resizable({
        edges: { left: '.roadmap-bar-handle-l', right: '.roadmap-bar-handle-r' },
        listeners: {
          start() { acc = 0; },
          move(ev: { edges?: { left?: boolean }; deltaRect?: { left: number; right: number } }) {
            acc += ev.edges?.left ? (ev.deltaRect?.left ?? 0) : (ev.deltaRect?.right ?? 0);
            preview(ev.edges?.left ? 'resize-start' : 'resize-end');
          },
          end(ev: { edges?: { left?: boolean } }) { commit(ev.edges?.left ? 'resize-start' : 'resize-end'); },
        },
      })
      .draggable({
        allowFrom: '.roadmap-bar-grip',
        listeners: {
          start() { acc = 0; },
          move(ev: { dx: number }) { acc += ev.dx; preview('move'); },
          end() { commit('move'); },
        },
      })
      .on('tap', () => live.current.onOpenEdit());

    return () => { ix.unset(); };
  }, [hasAnyDate]);

  // ----- bar rendering (visual reflects in-progress drag delta) -----
  let bar: React.ReactElement | null = null;
  if (hasAnyDate && anchorStartMs !== null && anchorEndMs !== null) {
    // Apply live drag preview to displayed coordinates.
    let dispStartMs = anchorStartMs;
    let dispEndMs = anchorEndMs;
    if (drag) {
      const deltaMs = (drag.deltaPx / range.pxPerDay) * DAY_MS;
      if (drag.mode === 'move') {
        dispStartMs = drag.origStartMs + deltaMs;
        dispEndMs = drag.origEndMs + deltaMs;
      } else if (drag.mode === 'resize-start') {
        dispStartMs = Math.min(drag.origStartMs + deltaMs, drag.origEndMs - MIN_DURATION_DAYS * DAY_MS);
        dispEndMs = drag.origEndMs;
      } else {
        dispStartMs = drag.origStartMs;
        dispEndMs = Math.max(drag.origEndMs + deltaMs, drag.origStartMs + MIN_DURATION_DAYS * DAY_MS);
      }
    }
    const width = Math.max(MIN_BAR_PX, ((dispEndMs - dispStartMs) / DAY_MS) * range.pxPerDay);
    const anchorLeft = (ms: number) => ((ms - range.startMs) / DAY_MS) * range.pxPerDay;
    // Both/start-anchored bars pin their LEFT edge at the start. A static (not being
    // dragged) end-only marker pins its RIGHT edge at the due date instead.
    const left = (!hasStart && hasEnd && !drag)
      ? anchorLeft(dispEndMs) + range.pxPerDay - width
      : anchorLeft(dispStartMs);
    const urgent = item.priority === 'urgent';
    // Show a range whenever the item has both ends, or a resize-drag is forming one.
    const showRange = (hasStart && hasEnd) || (!!drag && drag.mode !== 'move');
    const label = showRange
      ? `${fmtDayMonth(isoFromMs(dispStartMs))} → ${fmtDayMonth(isoFromMs(dispEndMs))}`
      : (hasStart ? `from ${fmtDayMonth(isoFromMs(dispStartMs))}` : `due ${fmtDayMonth(isoFromMs(dispEndMs))}`);
    const durationDays = Math.max(1, Math.round((dispEndMs - dispStartMs) / DAY_MS));
    const cursorClass = drag
      ? (drag.mode === 'move' ? ' roadmap-bar-cursor-move' : ' roadmap-bar-cursor-ew')
      : '';
    const openSide = hasStart ? 'due' : 'start';
    const title = (hasStart && hasEnd)
      ? `${item.name}\n${label} · ${item.priority} · ${item.state.toLowerCase()}\n${durationDays} day${durationDays === 1 ? '' : 's'}\nDrag a ↔ border to resize · grab the hand to move · click to edit`
      : `${item.name}\n${label}\nDrag the open ↔ border to set the ${openSide} date · grab the hand to move · click to edit`;
    bar = (
      <button
        ref={barRef}
        type="button"
        className={'roadmap-bar'
          + (isPartial ? ' roadmap-bar-partial' : '')
          + (urgent ? ' roadmap-bar-urgent' : '')
          + (isDirty ? ' roadmap-bar-dirty' : '')
          + (isEditing ? ' roadmap-bar-active' : '')
          + (drag ? ' roadmap-bar-dragging' : '')
          + cursorClass}
        style={{ left: `${left}px`, width: `${width}px`, background: stateColor }}
        title={title}
      >
        <span className="roadmap-bar-handle roadmap-bar-handle-l" aria-hidden="true" title="Drag to move the start border">
          <MoveHorizontal className="roadmap-bar-handle-icon" />
        </span>
        <span className="roadmap-bar-label">{label}</span>
        <span className="roadmap-bar-grip" aria-hidden="true" title="Drag to move the whole item">
          <Hand className="roadmap-bar-grip-icon" />
        </span>
        <span className="roadmap-bar-handle roadmap-bar-handle-r" aria-hidden="true" title="Drag to move the end border">
          <MoveHorizontal className="roadmap-bar-handle-icon" />
        </span>
      </button>
    );
  } else {
    // No dates: make the entire row track a click target with a hint near today.
    // bar is rendered as a full-width transparent overlay so clicking anywhere
    // in the row opens the date popover.
    bar = (
      <button
        ref={barRef}
        type="button"
        onClick={onOpenEdit}
        className={'roadmap-bar-rowclick' + (isEditing ? ' roadmap-bar-active' : '')}
        title={`${item.name}\nClick anywhere on this row to add dates`}
      >
        <span className="roadmap-bar-rowclick-hint">+ add dates</span>
      </button>
    );
  }

  return (
    <div className={'roadmap-row' + (depth === 1 ? ' roadmap-row-child' : '')}>
      <div className="roadmap-label" title={item.name}>
        <span className="roadmap-meta-id" title={displayId}>
          <span className="truncate">{displayId}</span>
        </span>
        <span className="roadmap-meta-name">
          {depth === 0 ? (
            hasChildren ? (
              <button
                type="button"
                className="roadmap-expand-btn"
                onClick={onToggleExpand}
                aria-label={expanded ? `Collapse ${childCount} sub-work item${childCount === 1 ? '' : 's'}` : `Expand ${childCount} sub-work item${childCount === 1 ? '' : 's'}`}
                title={expanded ? `Hide ${childCount} sub-work item${childCount === 1 ? '' : 's'}` : `Show ${childCount} sub-work item${childCount === 1 ? '' : 's'}`}
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
            ) : (
              <span className="roadmap-expand-spacer" aria-hidden="true" />
            )
          ) : (
            <span className="roadmap-arrow">→ </span>
          )}
          <button
            type="button"
            className="roadmap-meta-name-btn"
            onClick={() => setDetailOpen(true)}
            title={`${item.name} — click to open details`}
          >
            <span className="truncate">{item.name}</span>
            {isDirty && <span className="roadmap-dirty-dot" title="Staged change" />}
            {hasChildren && !expanded && (
              <span className="roadmap-child-badge" title={`${childCount} sub-work item${childCount === 1 ? '' : 's'}`}>{childCount}</span>
            )}
          </button>
        </span>
        <span className="roadmap-meta-state" title={item.state}>
          <span className="roadmap-state-dot" style={{ background: stateColor }} />
          <span className="truncate">{item.state}</span>
        </span>
        <span className="roadmap-meta-priority" title={priorityInfo.label}>
          <span className="roadmap-prio-dot" style={{ background: priorityInfo.color }} />
          <span className="truncate">{priorityInfo.label}</span>
        </span>
        <span className="roadmap-meta-assignee">
          {assigneeId ? (
            <span
              className="roadmap-avatar"
              style={{ background: assigneeColor }}
              title={extraAssignees > 0 ? `${assigneeName} +${extraAssignees}` : assigneeName}
            >
              {initials(assigneeName)}
              {extraAssignees > 0 && <span className="roadmap-avatar-plus">+{extraAssignees}</span>}
            </span>
          ) : (
            <span className="roadmap-avatar roadmap-avatar-empty" title="No assignee">·</span>
          )}
          <span
            className={'roadmap-overdue-wrap' + (isOverdue ? '' : ' roadmap-overdue-hidden')}
            aria-label={overdueReason ? `${overdueReason.title}. ${overdueReason.detail}` : ''}
            aria-hidden={isOverdue ? undefined : true}
            onMouseEnter={isOverdue ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setOverdueTip({ x: r.right, y: r.bottom + 6 });
            } : undefined}
            onMouseLeave={isOverdue ? () => setOverdueTip(null) : undefined}
          >
            <AlertTriangle className="roadmap-overdue-icon" />
          </span>
          {isOverdue && overdueTip && overdueReason && createPortal(
            <div className="roadmap-overdue-tip" style={{ left: overdueTip.x, top: overdueTip.y }} role="tooltip">
              <div className="roadmap-overdue-tip-title">
                <AlertTriangle className="h-3.5 w-3.5" />
                {overdueReason.title}
              </div>
              <div className="roadmap-overdue-tip-detail">{overdueReason.detail}</div>
            </div>,
            document.body,
          )}
        </span>
      </div>
      <div className="roadmap-track">
        {bar}
        {isEditing && (
          <DatePopover
            anchorEl={barRef.current}
            item={item}
            start={start}
            end={end}
            isDirty={isDirty}
            onStage={onStage}
            onRevert={onRevert}
            onClose={onCloseEdit}
          />
        )}
      </div>
      {detailOpen && <EditModal item={item} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}

function DatePopover({
  anchorEl, item, start, end, isDirty, onStage, onRevert, onClose,
}: {
  anchorEl: HTMLElement | null;
  item: WorkItem;
  start: string | null;
  end: string | null;
  isDirty: boolean;
  onStage: (patch: PendingEdit) => void;
  onRevert: () => void;
  onClose: () => void;
}) {
  const [draftStart, setDraftStart] = useState(start || '');
  const [draftEnd, setDraftEnd] = useState(end || '');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'below' | 'above' }>({ top: 0, left: 0, placement: 'below' });

  useEffect(() => {
    setDraftStart(start || '');
    setDraftEnd(end || '');
  }, [start, end]);

  useLayoutEffect(() => {
    if (!anchorEl) return;
    const update = () => {
      const r = anchorEl.getBoundingClientRect();
      const popoverW = 300;
      const popoverH = 180;
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = r.left;
      // Keep the popover within the horizontal viewport.
      if (left + popoverW + margin > vw) left = Math.max(margin, vw - popoverW - margin);
      if (left < margin) left = margin;
      let placement: 'below' | 'above' = 'below';
      let top = r.bottom + 6;
      if (top + popoverH > vh - margin) {
        // Not enough room below — flip above the bar.
        top = r.top - popoverH - 6;
        placement = 'above';
      }
      setPos({ top, left, placement });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorEl]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return; // click on the bar handled separately
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorEl]);

  const commitStart = (v: string) => {
    setDraftStart(v);
    const next: PendingEdit = {};
    next.start = v || null;
    if (draftEnd !== (item.end || '')) next.end = draftEnd || null;
    onStage(next);
  };
  const commitEnd = (v: string) => {
    setDraftEnd(v);
    const next: PendingEdit = {};
    if (draftStart !== (item.start || '')) next.start = draftStart || null;
    next.end = v || null;
    onStage(next);
  };

  const body = (
    <div
      ref={ref}
      className={'roadmap-popover roadmap-popover-portal roadmap-popover-' + pos.placement}
      role="dialog"
      aria-modal="false"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="roadmap-popover-head">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{item.type} · {item.state}</div>
          <div className="text-[12.5px] font-medium truncate" title={item.name}>{item.name}</div>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="roadmap-popover-body">
        <label className="roadmap-popover-field">
          <span>Start</span>
          <input
            type="date"
            value={draftStart}
            onChange={(e) => commitStart(e.target.value)}
            className="roadmap-popover-input"
          />
        </label>
        <label className="roadmap-popover-field">
          <span>Due</span>
          <input
            type="date"
            value={draftEnd}
            onChange={(e) => commitEnd(e.target.value)}
            className="roadmap-popover-input"
          />
        </label>
        {isDirty && (
          <button
            type="button"
            onClick={() => { onRevert(); onClose(); }}
            className="roadmap-popover-revert"
          >
            Revert
          </button>
        )}
      </div>
      <div className="roadmap-popover-foot">
        Changes apply on <strong>Update</strong> at top of the timeline.
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
