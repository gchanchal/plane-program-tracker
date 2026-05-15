import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, Search, X, AlertTriangle, Clock, Pause, UserPlus, Snowflake, Activity, TrendingUp, Users, Flame, Timer } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { PRIORITY_INFO, THRESHOLDS } from '@/lib/constants';
import { daysBetween, thirtyDaysAgoIso } from '@/lib/format';
import type { Priority, WorkItem } from '@/lib/types';
import { HBarList } from '@/components/HBarList';

const P_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const MIN_LOAD_FOR_CHART = 2;
const VELOCITY_WEEKS = 8;
const STALE_DAYS = 7;
const STALLED_WEEKS = 4;
const AVAILABLE_WIP_MAX = 3;
const CYCLE_OUTLIER_MULT = 2;
const CONCENTRATION_TOP_N = 5;

type Health = 'healthy' | 'heavy' | 'overload' | 'available' | 'stalled' | 'idle';
type SortCol = 'name' | 'velocity' | 'cycle' | 'started' | 'done30' | 'stale' | 'health';
type SortDir = 'asc' | 'desc';
type KpiFilter = 'all' | 'available' | 'overload' | 'stalled' | 'slow';

const HEALTH_INFO: Record<Health, { label: string; cls: string; rank: number }> = {
  overload:  { label: 'overload',  cls: 'over',  rank: 6 },
  stalled:   { label: 'stalled',   cls: 'stalled', rank: 5 },
  heavy:     { label: 'heavy',     cls: 'high',  rank: 4 },
  healthy:   { label: 'healthy',   cls: 'ok',    rank: 3 },
  available: { label: 'available', cls: 'avail', rank: 2 },
  idle:      { label: 'idle',      cls: 'idle',  rank: 1 },
};

interface CapRow {
  id: string;
  name: string;
  color: string;
  backlog: number;
  unstarted: number;
  started: number;
  done30: number;
  doneLast4w: number;
  weeklyVelocity: number[];
  velocityTrend: 'up' | 'down' | 'flat';
  medianCycle: number | null;
  stale: number;
  lastCompletedAt: string | null;
  weeksSinceLastDone: number | null;
  daysSinceLastDone: number | null;
  by_priority: Record<Priority, number>;
  health: Health;
  isSlow: boolean;
}

function classifyHealth(r: Omit<CapRow, 'health' | 'isSlow'>): Health {
  const totalWindow = r.started + r.done30;
  if (totalWindow === 0) return 'idle';
  if (r.started >= THRESHOLDS.wipOverload) return 'overload';
  if (r.started > 0 && r.weeksSinceLastDone !== null && r.weeksSinceLastDone >= STALLED_WEEKS) return 'stalled';
  if (r.started >= THRESHOLDS.wipHigh) return 'heavy';
  if (r.started === 0 && r.done30 > 0) return 'available';
  if (r.started < AVAILABLE_WIP_MAX && r.done30 > 0) return 'available';
  return 'healthy';
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  const w = 84, h = 20;
  if (values.length === 0) return <span className="text-muted-foreground text-[11px]">—</span>;
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${h - (v / max) * (h - 2) - 1}`).join(' ');
  const last = values[values.length - 1];
  const lastX = (values.length - 1) * step;
  const lastY = h - (last / max) * (h - 2) - 1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="inline-block align-middle">
      <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" points={pts} />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

interface KpiButtonProps {
  active: boolean;
  onClick: () => void;
  tone: 'cool' | 'bad' | 'warm' | 'violet' | 'good';
  label: string;
  value: number | string;
  sub: string;
  filterable?: boolean;
}
function KpiButton({ active, onClick, tone, label, value, sub, filterable = true }: KpiButtonProps) {
  const cls = 'kpi kpi-' + tone + (filterable ? ' kpi-filterable' : '') + (active ? ' kpi-active' : '');
  return (
    <button type="button" onClick={onClick} disabled={!filterable} className={cls} style={{ textAlign: 'left' }}>
      <div className="kpi-label"><span className="kpi-dot" />{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {active && <div className="kpi-active-mark">filtering ↓</div>}
    </button>
  );
}

interface AttentionCardProps {
  title: string; subtitle: string; Icon: typeof AlertTriangle;
  tone: 'bad' | 'warm' | 'cool' | 'good';
  rows: Array<{ id: string; name: string; color: string; metric: string }>;
  onPick?: (id: string) => void; empty: string;
}
function AttentionCard({ title, subtitle, Icon, tone, rows, onPick, empty }: AttentionCardProps) {
  return (
    <div className={'attn-card attn-' + tone}>
      <div className="attn-head">
        <Icon className="h-4 w-4" />
        <div className="flex-1">
          <div className="attn-title">{title} <span className="attn-count">{rows.length}</span></div>
          <div className="attn-sub">{subtitle}</div>
        </div>
      </div>
      <div className="attn-body">
        {rows.length === 0 ? (
          <div className="attn-empty">{empty}</div>
        ) : rows.slice(0, 6).map(r => (
          <button key={r.id} type="button" onClick={() => onPick?.(r.id)} className="attn-row" title="Jump to row in Workload table">
            <span className="avatar" style={{ background: r.color, width: 18, height: 18, fontSize: 9 }}>
              {(r.name || '?').charAt(0).toUpperCase()}
            </span>
            <span className="attn-row-name">{r.name}</span>
            <span className="attn-row-metric">{r.metric}</span>
          </button>
        ))}
        {rows.length > 6 && <div className="attn-more">+ {rows.length - 6} more</div>}
      </div>
    </div>
  );
}

// ---------- Member activity: ranked top-10 lists ----------
function fmtLastActive(days: number | null): string {
  if (days === null) return 'never';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

interface RankedRow {
  id: string;
  name: string;
  color: string;
  metric: string;
  metricMuted?: string;
  highlight?: boolean;
}

function RankedList({
  title, subtitle, Icon, tone, rows, onPick, empty,
}: {
  title: string;
  subtitle: string;
  Icon: typeof Activity;
  tone: 'good' | 'cool';
  rows: RankedRow[];
  onPick: (id: string) => void;
  empty: string;
}) {
  return (
    <div className={'rounded-lg border border-border bg-card overflow-hidden ranked-' + tone}>
      <div className="ranked-head">
        <Icon className="h-4 w-4" />
        <div className="flex-1 min-w-0">
          <div className="ranked-title">{title}</div>
          <div className="ranked-sub">{subtitle}</div>
        </div>
        <span className="ranked-pill">top {rows.length}</span>
      </div>
      <div>
        {rows.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-5">{empty}</div>
        ) : rows.map((r, i) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(r.id)}
            className="ranked-row"
            title={`Jump to ${r.name} in the workload table below`}
          >
            <span className="ranked-num">{i + 1}</span>
            <span className="avatar" style={{ background: r.color, width: 22, height: 22, fontSize: 10 }}>
              {(r.name || '?').charAt(0).toUpperCase()}
            </span>
            <span className="ranked-name">{r.name}</span>
            <span className="ranked-metric">
              {r.highlight ? <strong>{r.metric}</strong> : r.metric}
              {r.metricMuted && <span className="ranked-metric-sub">{r.metricMuted}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function CapacityView() {
  const { data } = useDashboard();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('started');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>('all');

  const rows = useMemo<CapRow[]>(() => {
    if (!data) return [];
    const today = new Date(data.today + 'T00:00:00Z');
    const since30 = thirtyDaysAgoIso(data.today);

    type Acc = Omit<CapRow, 'health' | 'isSlow' | 'velocityTrend' | 'medianCycle' | 'doneLast4w' | 'weeklyVelocity' | 'lastCompletedAt' | 'weeksSinceLastDone' | 'daysSinceLastDone' | 'stale'> & {
      cycleTimes: number[];
      weeklyVel: number[];
      lastCompletedTs: number | null;
      staleCount: number;
    };
    const byKey = new Map<string, Acc>();
    const ensure = (i: WorkItem): Acc => {
      const key = i.assignee_id || (i.assignee ? 'name:' + i.assignee : '__none__');
      let a = byKey.get(key);
      if (!a) {
        a = {
          id: key, name: i.assignee || 'Unassigned', color: i.assignee_color || '#888780',
          backlog: 0, unstarted: 0, started: 0, done30: 0,
          by_priority: { urgent: 0, high: 0, medium: 0, low: 0, none: 0 },
          cycleTimes: [], weeklyVel: new Array(VELOCITY_WEEKS).fill(0),
          lastCompletedTs: null, staleCount: 0,
        };
        byKey.set(key, a);
      }
      return a;
    };

    for (const i of data.items) {
      const a = ensure(i);
      if (i.state_group === 'backlog') a.backlog++;
      else if (i.state_group === 'unstarted') a.unstarted++;
      else if (i.state_group === 'started') {
        a.started++;
        a.by_priority[i.priority] = (a.by_priority[i.priority] || 0) + 1;
        if (i.updated_at) {
          const idle = daysBetween(i.updated_at, data.today);
          if (idle !== null && idle > STALE_DAYS) a.staleCount++;
        }
      }
      if (i.state_group === 'completed' && i.updated_at) {
        if ((i.updated_at || '').slice(0, 10) >= since30) a.done30++;
        const cycle = daysBetween(i.created_at, i.updated_at);
        if (cycle !== null && cycle >= 0) a.cycleTimes.push(cycle);
        const upd = new Date(i.updated_at);
        const daysAgo = Math.floor((today.getTime() - upd.getTime()) / 86400000);
        const wkAgo = Math.floor(daysAgo / 7);
        if (wkAgo >= 0 && wkAgo < VELOCITY_WEEKS) a.weeklyVel[VELOCITY_WEEKS - 1 - wkAgo] += 1;
        const ts = upd.getTime();
        if (a.lastCompletedTs === null || ts > a.lastCompletedTs) a.lastCompletedTs = ts;
      }
    }

    // Compute team median cycle time first so we can flag slow finishers.
    const teamSamples: number[] = [];
    for (const a of byKey.values()) for (const c of a.cycleTimes) teamSamples.push(c);
    teamSamples.sort((x, y) => x - y);
    const teamMedian = teamSamples.length ? teamSamples[Math.floor(teamSamples.length / 2)] : 0;

    const out: CapRow[] = [];
    for (const a of byKey.values()) {
      a.cycleTimes.sort((x, y) => x - y);
      const medianCycle = a.cycleTimes.length ? a.cycleTimes[Math.floor(a.cycleTimes.length / 2)] : null;
      const doneLast4w = a.weeklyVel.slice(-4).reduce((s, v) => s + v, 0);
      const prev4 = a.weeklyVel.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
      const last4 = doneLast4w / 4;
      const velocityTrend: 'up' | 'down' | 'flat' =
        last4 > prev4 + 0.25 ? 'up' :
        last4 < prev4 - 0.25 ? 'down' : 'flat';
      const daysSinceLastDone = a.lastCompletedTs ? Math.floor((today.getTime() - a.lastCompletedTs) / 86400000) : null;
      const weeksSinceLastDone = daysSinceLastDone !== null ? Math.floor(daysSinceLastDone / 7) : null;
      const lastCompletedAt = a.lastCompletedTs ? new Date(a.lastCompletedTs).toISOString().slice(0, 10) : null;

      const partial = {
        id: a.id, name: a.name, color: a.color,
        backlog: a.backlog, unstarted: a.unstarted, started: a.started, done30: a.done30,
        doneLast4w, weeklyVelocity: a.weeklyVel, velocityTrend,
        medianCycle, stale: a.staleCount,
        lastCompletedAt, weeksSinceLastDone, daysSinceLastDone,
        by_priority: a.by_priority,
      };
      const isSlow = medianCycle !== null && teamMedian > 0 && medianCycle > teamMedian * CYCLE_OUTLIER_MULT;
      out.push({ ...partial, health: classifyHealth(partial), isSlow });
    }
    return out;
  }, [data]);

  // ---------- Member activity: derive top lists + ghost count ----------
  const memberSummary = useMemo(() => {
    if (!data) return { active: [], inactive: [], totalMembers: 0, withItems: 0, ghosts: 0 };
    const totalMembers = Object.keys(data.users || {}).length;
    const realRows = rows.filter(r => r.id !== '__none__'); // exclude virtual "Unassigned"
    const withItems = realRows.length;
    const ghosts = Math.max(0, totalMembers - withItems);

    // ACTIVE = had at least one completion in the last 4 weeks. Sorted by volume.
    const active = realRows
      .filter(r => r.doneLast4w > 0)
      .sort((a, b) => (b.doneLast4w - a.doneLast4w) || ((a.daysSinceLastDone ?? 999) - (b.daysSinceLastDone ?? 999)))
      .slice(0, 10);

    // INACTIVE = has items assigned (active or queued) but ZERO completions in
    // the last 4w. Sorted by total items held desc — biggest sitters surface first.
    const inactive = realRows
      .filter(r => r.doneLast4w === 0 && (r.started + r.unstarted + r.backlog) > 0)
      .sort((a, b) => {
        const aTotal = a.started + a.unstarted + a.backlog;
        const bTotal = b.started + b.unstarted + b.backlog;
        return (bTotal - aTotal) || ((b.daysSinceLastDone ?? 999) - (a.daysSinceLastDone ?? 999));
      })
      .slice(0, 10);

    return { active, inactive, totalMembers, withItems, ghosts };
  }, [data, rows]);

  if (!data) return <div className="text-sm text-muted-foreground p-4">No data.</div>;

  // ---------- Team aggregates ----------
  const peopleActive = rows.filter(r => r.started > 0).length;
  const overloadedRows = rows.filter(r => r.health === 'overload');
  const stalledRows    = rows.filter(r => r.health === 'stalled');
  const availableRows  = rows.filter(r => r.health === 'available');
  const slowRows       = rows.filter(r => r.isSlow).sort((a, b) => (b.medianCycle || 0) - (a.medianCycle || 0));
  const totalWip = rows.reduce((a, r) => a + r.started, 0);

  const teamCycleSamples: number[] = [];
  for (const i of data.items) {
    if (i.state_group !== 'completed') continue;
    const c = daysBetween(i.created_at, i.updated_at);
    if (c !== null && c >= 0) teamCycleSamples.push(c);
  }
  teamCycleSamples.sort((a, b) => a - b);
  const teamMedianCycle = teamCycleSamples.length ? teamCycleSamples[Math.floor(teamCycleSamples.length / 2)] : 0;

  const teamWeeklyDone = new Array(VELOCITY_WEEKS).fill(0);
  for (const r of rows) for (let w = 0; w < VELOCITY_WEEKS; w++) teamWeeklyDone[w] += r.weeklyVelocity[w];
  const throughput4w = Math.round(teamWeeklyDone.slice(-4).reduce((s, v) => s + v, 0) / 4);
  const throughputPrev = teamWeeklyDone.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
  const throughputTrend: 'up' | 'down' | 'flat' =
    throughput4w > throughputPrev + 0.5 ? 'up' :
    throughput4w < throughputPrev - 0.5 ? 'down' : 'flat';
  const forecastWeeks = throughput4w > 0 ? Math.ceil(totalWip / throughput4w) : null;

  const wipDesc = rows.slice().sort((a, b) => b.started - a.started);
  const topNwip = wipDesc.slice(0, CONCENTRATION_TOP_N).reduce((s, r) => s + r.started, 0);
  const concentrationPct = totalWip > 0 ? Math.round(100 * topNwip / totalWip) : 0;
  const concentrationLeader = wipDesc[0];
  const staleHolders = rows.filter(r => r.stale >= 3).sort((a, b) => b.stale - a.stale);

  const onPick = (id: string) => {
    setHighlightedId(id);
    setTimeout(() => {
      const el = document.querySelector(`[data-cap-row-id="${CSS.escape(id)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
    setTimeout(() => setHighlightedId(null), 2500);
  };

  // ---------- KPI filter application ----------
  const filterMatches = (r: CapRow): boolean => {
    switch (kpiFilter) {
      case 'available': return r.health === 'available';
      case 'overload':  return r.health === 'overload';
      case 'stalled':   return r.health === 'stalled';
      case 'slow':      return r.isSlow;
      case 'all':
      default:          return true;
    }
  };
  const kpiFilteredRows = kpiFilter === 'all' ? rows : rows.filter(filterMatches);

  const toggleKpi = (k: KpiFilter) => setKpiFilter(prev => prev === k ? 'all' : k);

  // ---------- Charts (use kpiFilteredRows) ----------
  const sortedByLoad = kpiFilteredRows.slice().sort((a, b) => (b.started + b.done30) - (a.started + a.done30));
  const loadVisible = sortedByLoad.filter(r => r.started >= MIN_LOAD_FOR_CHART).slice(0, 25);
  const loadHidden = sortedByLoad.filter(r => r.started > 0 && r.started < MIN_LOAD_FOR_CHART);
  const loadHiddenCount = loadHidden.length;
  const loadHiddenItems = loadHidden.reduce((a, r) => a + r.started, 0);
  const loadRows = loadVisible.map(r => ({
    label: r.name, value: r.started,
    segments: P_ORDER.map(p => ({ key: p, value: r.by_priority[p] || 0, color: PRIORITY_INFO[p].color })),
  }));
  const doneRows = sortedByLoad.filter(r => r.done30 > 0).slice(0, 25)
    .map(r => ({ label: r.name, value: r.done30, color: r.color }));

  // ---------- Workload table ----------
  const tableSource = kpiFilteredRows;
  const filteredRows = (() => {
    const q = searchQuery.trim().toLowerCase();
    let list = q ? tableSource.filter(r => r.name.toLowerCase().includes(q)) : tableSource.slice();
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let va: string | number = '';
      let vb: string | number = '';
      switch (sortCol) {
        case 'name':     va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case 'velocity': va = a.doneLast4w;         vb = b.doneLast4w;         break;
        case 'cycle':    va = a.medianCycle ?? -1;  vb = b.medianCycle ?? -1;  break;
        case 'started':  va = a.started;            vb = b.started;            break;
        case 'done30':   va = a.done30;             vb = b.done30;             break;
        case 'stale':    va = a.stale;              vb = b.stale;              break;
        case 'health':   va = HEALTH_INFO[a.health].rank; vb = HEALTH_INFO[b.health].rank; break;
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return  1 * dir;
      return a.name.localeCompare(b.name);
    });
    return list;
  })();

  const cycleSort = (col: SortCol) => {
    if (sortCol !== col) { setSortCol(col); setSortDir(col === 'name' ? 'asc' : 'desc'); }
    else { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
  };
  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortCol !== col) return <ArrowUpDown className="h-3 w-3 opacity-40 inline" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" />;
  };

  return (
    <div className="space-y-3">
      {/* ============ KPI ROW (clickable filters) ============ */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiButton
          active={kpiFilter === 'available'}
          onClick={() => toggleKpi('available')}
          tone="cool"
          label="Available"
          value={availableRows.length}
          sub="people who can take more work"
        />
        <KpiButton
          active={kpiFilter === 'overload'}
          onClick={() => toggleKpi('overload')}
          tone="bad"
          label="Overloaded"
          value={overloadedRows.length}
          sub={`WIP ≥ ${THRESHOLDS.wipOverload}`}
        />
        <KpiButton
          active={kpiFilter === 'stalled'}
          onClick={() => toggleKpi('stalled')}
          tone="warm"
          label="Stalled"
          value={stalledRows.length}
          sub={`WIP, no completions in ${STALLED_WEEKS}w`}
        />
        <KpiButton
          active={kpiFilter === 'slow'}
          onClick={() => toggleKpi('slow')}
          tone="violet"
          label="Slow finishers"
          value={slowRows.length}
          sub={`cycle > ${CYCLE_OUTLIER_MULT}× team median (${teamMedianCycle}d)`}
        />
      </section>

      {kpiFilter !== 'all' && (
        <div className="cap-filter-banner">
          <span className="text-sm">
            Showing only <strong>{kpiFilter === 'available' ? 'available' : kpiFilter === 'overload' ? 'overloaded' : kpiFilter === 'stalled' ? 'stalled' : 'slow-finisher'}</strong> people
            ({kpiFilteredRows.length} of {rows.length}). Charts and table below are filtered.
          </span>
          <button type="button" onClick={() => setKpiFilter('all')} className="cap-filter-clear">
            <X className="h-3 w-3" />Clear filter
          </button>
        </div>
      )}

      {/* ============ FORECAST + CONCENTRATION ============ */}
      <section className="cap-forecast">
        <div className="cap-forecast-block">
          <div className="cap-forecast-icon"><Activity className="h-4 w-4" /></div>
          <div>
            <div className="cap-forecast-headline">
              {totalWip} items in flight · clearing at {throughput4w}/wk
              {forecastWeeks !== null
                ? <> · ETA <strong>{forecastWeeks} {forecastWeeks === 1 ? 'week' : 'weeks'}</strong></>
                : <> · <strong className="text-amber-700 dark:text-amber-400">no completions yet</strong></>}
              {throughputTrend === 'up'   && <ArrowUp   className="h-3.5 w-3.5 text-green-600 inline ml-1" />}
              {throughputTrend === 'down' && <ArrowDown className="h-3.5 w-3.5 text-red-600 inline ml-1" />}
            </div>
            <div className="cap-forecast-sub">Median cycle <strong className="text-foreground">{teamMedianCycle}d</strong> · directional, assumes throughput holds</div>
          </div>
        </div>
        <div className="cap-forecast-divider" />
        <div className="cap-forecast-block">
          <div className="cap-forecast-icon"><Users className="h-4 w-4" /></div>
          <div>
            <div className="cap-forecast-headline">
              Top {CONCENTRATION_TOP_N} hold <strong>{concentrationPct}%</strong> of active WIP
              {concentrationLeader && concentrationLeader.started > 0 && <> · {concentrationLeader.name} alone has <strong>{concentrationLeader.started}</strong></>}
            </div>
            <div className="cap-forecast-sub">
              {concentrationPct >= 60 ? 'High concentration — single-point-of-failure risk.' :
               concentrationPct >= 40 ? 'Moderate concentration — watch for bottlenecks.' :
               'Distributed — healthy spread.'}
            </div>
          </div>
        </div>
      </section>

      {/* ============ NEEDS ATTENTION (always all rows; not affected by filter) ============ */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />Needs attention
          </h2>
          <span className="text-xs text-muted-foreground">click any name to jump to their row below</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <AttentionCard
            title="Overloaded" subtitle={`WIP ≥ ${THRESHOLDS.wipOverload} — reassign or de-scope`}
            Icon={AlertTriangle} tone="bad"
            rows={overloadedRows.sort((a, b) => b.started - a.started).map(r => ({ id: r.id, name: r.name, color: r.color, metric: `${r.started} WIP` }))}
            onPick={onPick} empty="Nobody is overloaded right now."
          />
          <AttentionCard
            title="Stalled" subtitle={`Active WIP, no completions in ${STALLED_WEEKS}w — check for blockers`}
            Icon={Pause} tone="warm"
            rows={stalledRows.sort((a, b) => (b.weeksSinceLastDone || 99) - (a.weeksSinceLastDone || 99)).map(r => ({
              id: r.id, name: r.name, color: r.color,
              metric: r.weeksSinceLastDone === null ? 'never finished' : `${r.weeksSinceLastDone}w idle · ${r.started} WIP`,
            }))}
            onPick={onPick} empty="No stalled assignees."
          />
          <AttentionCard
            title="Available" subtitle={`WIP < ${AVAILABLE_WIP_MAX}, recent completions — can take more`}
            Icon={UserPlus} tone="good"
            rows={availableRows.sort((a, b) => (b.doneLast4w - a.doneLast4w) || (a.started - b.started)).map(r => ({
              id: r.id, name: r.name, color: r.color, metric: `${r.started} WIP · ${r.doneLast4w} done/4w`,
            }))}
            onPick={onPick} empty="No available capacity."
          />
          <AttentionCard
            title="Stale-item holders" subtitle={`≥3 active items not touched in ${STALE_DAYS}d — check status`}
            Icon={Snowflake} tone="cool"
            rows={staleHolders.map(r => ({ id: r.id, name: r.name, color: r.color, metric: `${r.stale} of ${r.started} WIP stale` }))}
            onPick={onPick} empty="No stale-item holders."
          />
        </div>
        {slowRows.length > 0 && (
          <div className="mt-3 cap-slow-banner">
            <Clock className="h-4 w-4 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium">
                {slowRows.length} {slowRows.length === 1 ? 'person' : 'people'} have cycle time &gt;{CYCLE_OUTLIER_MULT}× team median ({teamMedianCycle}d)
              </div>
              <div className="text-[11.5px] text-muted-foreground">Coaching opportunity — what's keeping their items in flight longer?</div>
            </div>
            <div className="text-xs text-muted-foreground flex gap-2 flex-wrap">
              {slowRows.slice(0, 5).map(r => (
                <button key={r.id} onClick={() => onPick(r.id)} className="cap-slow-chip">
                  {r.name} <strong>{r.medianCycle}d</strong>
                </button>
              ))}
              {slowRows.length > 5 && <span className="self-center">+ {slowRows.length - 5} more</span>}
            </div>
          </div>
        )}
      </section>

      {/* ============ MEMBER ACTIVITY (ranked top 10s) ============ */}
      <section>
        <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />Member activity
          </h2>
          <span className="text-xs text-muted-foreground">
            {memberSummary.totalMembers} workspace members ·
            {' '}<strong className="text-foreground">{memberSummary.withItems}</strong> with items in window ·
            {' '}<strong className="text-foreground">{memberSummary.ghosts}</strong> inactive (no items)
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <RankedList
            title="Active"
            subtitle="Completed at least one item in the last 4 weeks"
            Icon={Flame}
            tone="good"
            rows={memberSummary.active.map(r => ({
              id: r.id, name: r.name, color: r.color,
              metric: `${r.doneLast4w} done`,
              metricMuted: r.daysSinceLastDone !== null ? ` · last ${fmtLastActive(r.daysSinceLastDone)}` : '',
              highlight: true,
            }))}
            onPick={onPick}
            empty="No completions in this window."
          />
          <RankedList
            title="Inactive"
            subtitle="Have items assigned but zero completions in the last 4 weeks"
            Icon={Timer}
            tone="cool"
            rows={memberSummary.inactive.map(r => {
              const total = r.started + r.unstarted + r.backlog;
              return {
                id: r.id, name: r.name, color: r.color,
                metric: `${total} items held`,
                metricMuted: r.daysSinceLastDone !== null
                  ? ` · last ${fmtLastActive(r.daysSinceLastDone)}`
                  : ' · never finished anything',
                highlight: true,
              };
            })}
            onPick={onPick}
            empty="Everyone with items is shipping."
          />
        </div>
      </section>

      {/* ============ CHARTS (filtered) ============ */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="chart-box">
          <h3>
            Active load by person <span className="approx">stacked by priority · WIP &ge; {MIN_LOAD_FOR_CHART}</span>
            {peopleActive > 0 && (peopleActive !== sortedByLoad.length || kpiFilter !== 'all') && (
              <span className="approx">· filtered</span>
            )}
          </h3>
          <div className="flex items-center gap-3 mb-2 text-[11px] text-muted-foreground flex-wrap">
            {P_ORDER.map(p => (
              <span key={p} className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: PRIORITY_INFO[p].color }} />
                {PRIORITY_INFO[p].label}
              </span>
            ))}
          </div>
          <HBarList rows={loadRows} empty={kpiFilter === 'all' ? 'No assignees with WIP at or above the threshold.' : 'No filtered assignees with WIP at or above the threshold.'} />
          {loadHiddenCount > 0 && (
            <div className="mt-3 pt-2.5 border-t border-border text-[11px] text-muted-foreground">
              + <strong className="text-foreground">{loadHiddenCount}</strong> {loadHiddenCount === 1 ? 'person' : 'people'} with 1 active item ({loadHiddenItems} items total) — hidden to keep the chart scannable.
            </div>
          )}
        </div>
        <div className="chart-box">
          <h3>Completed (30d) by person <span className="approx">approx</span></h3>
          <HBarList rows={doneRows} empty="No completions in window." />
        </div>
      </section>

      {/* ============ WORKLOAD TABLE ============ */}
      <section>
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />Workload by assignee
          </h2>
          <span className="text-xs text-muted-foreground ml-auto">Velocity = last 8w · trend marker compares last 4w to prior 4w</span>
        </div>
        <div className="flex items-center gap-3 mb-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search assignees…"
              className="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-border bg-card text-foreground outline-none focus:ring-2 focus:ring-ring/30"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {searchQuery && <span className="text-xs text-muted-foreground">{filteredRows.length} of {tableSource.length} match</span>}
          {(searchQuery || sortCol !== 'started' || sortDir !== 'desc' || kpiFilter !== 'all') && (
            <button type="button" onClick={() => { setSearchQuery(''); setSortCol('started'); setSortDir('desc'); setKpiFilter('all'); }}
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />Clear all filters
            </button>
          )}
        </div>
        <div className="rounded-lg border border-border overflow-hidden bg-card">
          <div className="cap-row cap-row-rich cap-head">
            <button type="button" onClick={() => cycleSort('name')}     className="cap-th" style={{ textAlign: 'left' }}>Assignee <SortIcon col="name" /></button>
            <button type="button" onClick={() => cycleSort('velocity')} className="cap-th" style={{ textAlign: 'left' }}>Velocity (8w) <SortIcon col="velocity" /></button>
            <button type="button" onClick={() => cycleSort('started')}  className="cap-th" style={{ textAlign: 'right' }}>Active WIP <SortIcon col="started" /></button>
            <button type="button" onClick={() => cycleSort('cycle')}    className="cap-th" style={{ textAlign: 'right' }}>Cycle (med) <SortIcon col="cycle" /></button>
            <button type="button" onClick={() => cycleSort('done30')}   className="cap-th" style={{ textAlign: 'right' }}>Done 30d <SortIcon col="done30" /></button>
            <button type="button" onClick={() => cycleSort('stale')}    className="cap-th" style={{ textAlign: 'right' }}>Stale <SortIcon col="stale" /></button>
            <button type="button" onClick={() => cycleSort('health')}   className="cap-th" style={{ textAlign: 'center' }}>Health <SortIcon col="health" /></button>
          </div>
          {filteredRows.length === 0 ? (
            <div className="action-empty">{searchQuery ? `No assignees matching "${searchQuery}".` : 'No assignees matching current filter.'}</div>
          ) : filteredRows.map(r => {
            const initial = (r.name || '?').charAt(0).toUpperCase();
            const h = HEALTH_INFO[r.health];
            return (
              <div key={r.id} data-cap-row-id={r.id}
                className={'cap-row cap-row-rich' + (highlightedId === r.id ? ' cap-row-highlight' : '')}>
                <div className="cap-name">
                  <span className="avatar" style={{ background: r.color }}>{initial}</span>
                  <span className="name">{r.name}</span>
                </div>
                <div className="cap-vel">
                  <Sparkline values={r.weeklyVelocity} color={r.color} />
                  <span className="cap-vel-num">
                    {r.doneLast4w}
                    {r.velocityTrend === 'up'   && <ArrowUp   className="h-3 w-3 text-green-600 inline ml-0.5" />}
                    {r.velocityTrend === 'down' && <ArrowDown className="h-3 w-3 text-red-600 inline ml-0.5" />}
                  </span>
                </div>
                <div className="cap-num"><strong>{r.started}</strong></div>
                <div className="cap-num">{r.medianCycle === null ? <span className="muted">—</span> : <>{r.medianCycle}<span className="muted">d</span></>}</div>
                <div className={'cap-num' + (r.done30 ? '' : ' muted')}>{r.done30}</div>
                <div className={'cap-num' + (r.stale ? ' cap-num-bad' : ' muted')}>{r.stale}</div>
                <div style={{ textAlign: 'center' }}><span className={'cap-flag ' + h.cls}>{h.label}</span></div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
