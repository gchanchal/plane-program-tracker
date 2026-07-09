/**
 * Reports tab — a report gallery styled after Jira. Two sections (Agile, Work
 * analysis) of cards; each opens a fully-working widget computed live from the
 * cached work-item data (and refresh-snapshot history where a report needs a
 * real time series).
 *
 * Data reality: Plane's dataset here has no sprint/cycle or version/release
 * entities, so the three Jira reports that depend on them (Sprint, Version,
 * Release Burndown) are adapted to the nearest real signal — the active display
 * window as the "sprint", and portfolios (epics/modules) as releases — and are
 * marked as approximations, matching the app's existing `.approx` convention.
 */
import { useMemo, useState, type FC } from 'react';
import {
  Activity, BarChart3, CalendarClock, Clock, Flame, Gauge,
  History, Hourglass, Info, Layers, LineChart as LineChartIcon, ListChecks,
  Maximize2, Minimize2, PieChart as PieChartIcon, Rocket, Target, TrendingUp, Milestone,
  type LucideIcon,
} from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { PRIORITY_INFO, TYPE_COLORS } from '@/lib/constants';
import { daysBetween, fmtShortDate, isoWeekStart } from '@/lib/format';
import type { DashboardData, StateGroup, WorkItem } from '@/lib/types';
import { BarChart } from '@/components/charts/bar-chart';
import { Bar } from '@/components/charts/bar';
import { AreaChart } from '@/components/charts/area-chart';
import { Area } from '@/components/charts/area';
import { Grid } from '@/components/charts/grid';
import { XAxis } from '@/components/charts/x-axis';
import { ChartTooltip } from '@/components/charts/tooltip/chart-tooltip';
import { PieChart } from '@/components/charts/pie-chart';
import { PieSlice } from '@/components/charts/pie-slice';
import { PieCenter } from '@/components/charts/pie-center';
import { HBarList, type HBarRow } from '@/components/HBarList';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const G_ORDER: StateGroup[] = ['completed', 'started', 'unstarted', 'backlog', 'cancelled'];
const GROUP_LABEL: Record<StateGroup, string> = {
  completed: 'Completed', started: 'In progress', unstarted: 'Unstarted',
  backlog: 'Backlog', cancelled: 'Cancelled',
};

const iso = (s?: string | null): string | null => (s ? s.slice(0, 10) : null);
const createdIso = (i: WorkItem) => iso(i.created_at);
/** Completion date proxy: an item's updated_at once it landed in `completed`. */
const resolvedIso = (i: WorkItem) => (i.state_group === 'completed' ? iso(i.updated_at) : null);
const isOpen = (i: WorkItem) => i.state_group !== 'completed' && i.state_group !== 'cancelled';

function eachDay(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const d = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  // Guard against pathological ranges.
  for (let guard = 0; d <= end && guard < 800; guard++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function windowStart(data: DashboardData): string {
  let min: string | null = null;
  for (const i of data.items) {
    const c = createdIso(i);
    if (c && (!min || c < min)) min = c;
  }
  return data.cutoff && (!min || data.cutoff > min) ? data.cutoff : (min || data.today);
}

interface FlowPoint {
  [key: string]: number | Date | string;
  date: Date; day: string;
  createdCum: number; resolvedCum: number; remaining: number;
}

/** Daily cumulative created vs resolved across the window. */
function flowSeries(data: DashboardData): FlowPoint[] {
  const start = windowStart(data);
  const createdBy = new Map<string, number>();
  const resolvedBy = new Map<string, number>();
  for (const i of data.items) {
    const c = createdIso(i);
    if (c && c >= start) createdBy.set(c, (createdBy.get(c) || 0) + 1);
    const r = resolvedIso(i);
    if (r && r >= start) resolvedBy.set(r, (resolvedBy.get(r) || 0) + 1);
  }
  let cc = 0, rr = 0;
  return eachDay(start, data.today).map(day => {
    cc += createdBy.get(day) || 0;
    rr += resolvedBy.get(day) || 0;
    return { date: new Date(day + 'T00:00:00Z'), day, createdCum: cc, resolvedCum: rr, remaining: cc - rr };
  });
}

type Field = 'state_group' | 'priority' | 'type' | 'assignee';
const FIELD_OPTS: { key: Field; label: string }[] = [
  { key: 'state_group', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'type', label: 'Type' },
  { key: 'assignee', label: 'Assignee' },
];

function fieldValue(i: WorkItem, f: Field): string {
  if (f === 'state_group') return GROUP_LABEL[i.state_group] || i.state_group;
  if (f === 'priority') return PRIORITY_INFO[i.priority]?.label || i.priority;
  if (f === 'type') return i.type || 'Other';
  return i.assignee || 'Unassigned';
}

const PALETTE = ['#378ADD', '#3B6D11', '#EF9F27', '#A32D2D', '#8280FF', '#4C49F8', '#EF5974', '#888780'];

function groupBy(items: WorkItem[], f: Field): { label: string; value: number }[] {
  const m = new Map<string, number>();
  for (const i of items) {
    const k = fieldValue(i, f);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Array.from(m, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

/** Stacked state-group breakdown per group value — for the Group-By report. */
function groupByStacked(items: WorkItem[], f: Field, data: DashboardData): HBarRow[] {
  const m = new Map<string, Record<StateGroup, number>>();
  for (const i of items) {
    const k = fieldValue(i, f);
    const rec = m.get(k) || { completed: 0, started: 0, unstarted: 0, backlog: 0, cancelled: 0 };
    rec[i.state_group] = (rec[i.state_group] || 0) + 1;
    m.set(k, rec);
  }
  return Array.from(m, ([label, rec]) => {
    const total = G_ORDER.reduce((a, g) => a + rec[g], 0);
    return {
      label,
      value: total,
      segments: G_ORDER.filter(g => rec[g] > 0).map(g => ({
        key: GROUP_LABEL[g], value: rec[g], color: data.state_group_info[g]?.color || '#888',
      })),
    };
  }).sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function ApproxNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-md px-3 py-2 mb-3">
      <strong className="text-foreground">Adapted:</strong> {children}
    </div>
  );
}

function Empty({ children }: { children?: React.ReactNode }) {
  return <div className="chart-empty">{children || 'Not enough data yet.'}</div>;
}

function FieldPicker({ value, onChange }: { value: Field; onChange: (f: Field) => void }) {
  return (
    <div className="velocity-toggle mb-3">
      {FIELD_OPTS.map(o => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)}
          className={'velocity-toggle-btn' + (value === o.key ? ' active' : '')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AGILE reports
// ---------------------------------------------------------------------------

const BurndownReport: FC = () => {
  const { data } = useDashboard();
  const series = useMemo(() => {
    if (!data) return [];
    const flow = flowSeries(data);
    if (!flow.length) return [];
    const start = flow[0].remaining;
    const n = flow.length - 1 || 1;
    return flow.map((p, idx) => ({ date: p.date, remaining: p.remaining, ideal: Math.max(0, start * (1 - idx / n)) }));
  }, [data]);
  if (!data) return null;
  if (series.length < 2) return <Empty />;
  const last = series[series.length - 1];
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="violet" label="Remaining open" value={last.remaining} sub="unresolved in window" />
        <Kpi tone="good" label="Peak scope" value={Math.max(...series.map(s => s.remaining))} sub="max open at once" />
        <Kpi tone="cool" label="vs ideal" value={Math.round(last.remaining - last.ideal)} sub="above the guideline" />
      </section>
      <div className="chart-box">
        <h3>Remaining work over time <span className="approx">open items · ideal guideline</span></h3>
        <AreaChart data={series} xDataKey="date" aspectRatio="2.6 / 1" margin={{ top: 12, right: 20, bottom: 32, left: 40 }}>
          <Grid />
          <Area dataKey="remaining" fill="#A32D2D" fillOpacity={0.3} />
          <Area dataKey="ideal" fill="#B8B4A8" fillOpacity={0.12} />
          <XAxis numTicks={6} />
          <ChartTooltip />
        </AreaChart>
      </div>
    </>
  );
};

const BurnupReport: FC = () => {
  const { data } = useDashboard();
  const series = useMemo(() => (data ? flowSeries(data) : []), [data]);
  if (!data) return null;
  if (series.length < 2) return <Empty />;
  const last = series[series.length - 1];
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="cool" label="Total scope" value={last.createdCum} sub="created in window" />
        <Kpi tone="good" label="Completed" value={last.resolvedCum} sub="resolved in window" />
        <Kpi tone="violet" label="Completion" value={last.createdCum ? Math.round((100 * last.resolvedCum) / last.createdCum) : 0} suffix="%" sub="of scope done" />
      </section>
      <div className="chart-box">
        <h3>Scope vs completed (cumulative)</h3>
        <AreaChart data={series} xDataKey="date" aspectRatio="2.6 / 1" margin={{ top: 12, right: 20, bottom: 32, left: 40 }}>
          <Grid />
          <Area dataKey="createdCum" fill="#85B7EB" fillOpacity={0.25} />
          <Area dataKey="resolvedCum" fill="#3B6D11" fillOpacity={0.4} />
          <XAxis numTicks={6} />
          <ChartTooltip />
        </AreaChart>
      </div>
    </>
  );
};

function weeklyCompleted(data: DashboardData): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const i of data.items) {
    const r = resolvedIso(i);
    if (r) { const w = isoWeekStart(r); m.set(w, (m.get(w) || 0) + 1); }
  }
  return Array.from(m.keys()).sort().slice(-12).map(w => ({ name: w.slice(5), count: m.get(w) || 0 }));
}

const VelocityReport: FC = () => {
  const { data } = useDashboard();
  const buckets = useMemo(() => (data ? weeklyCompleted(data) : []), [data]);
  if (!data) return null;
  if (!buckets.length) return <Empty>No completed items in the window.</Empty>;
  const avg = Math.round(buckets.reduce((a, b) => a + b.count, 0) / buckets.length);
  const best = Math.max(...buckets.map(b => b.count));
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="good" label="Avg velocity" value={avg} sub="completed / week" />
        <Kpi tone="cool" label="Best week" value={best} sub="peak completed" />
        <Kpi tone="violet" label="Weeks tracked" value={buckets.length} sub="in window" />
      </section>
      <div className="chart-box">
        <h3>Completed per week <span className="approx">last {buckets.length} weeks</span></h3>
        <BarChart data={buckets} xDataKey="name" aspectRatio="3 / 1" margin={{ top: 12, right: 16, bottom: 30, left: 36 }}>
          <Grid />
          <Bar dataKey="count" fill="#3B6D11" />
          <ChartTooltip />
        </BarChart>
      </div>
    </>
  );
};

const CfdReport: FC = () => {
  const { data, history } = useDashboard();
  const rows = useMemo(() => history.filter(h => h.ts).map(h => {
    const row: Record<string, number | Date> = { date: new Date(h.ts) };
    for (const g of G_ORDER) row[g] = h.group_counts?.[g] || 0;
    return row;
  }), [history]);
  if (!data) return null;
  if (rows.length < 2) return <Empty>Needs at least 2 refreshes to build a flow diagram. Refresh this project a few more times.</Empty>;
  return (
    <div className="chart-box">
      <h3>Status mix over refreshes <span className="approx">snapshot history</span></h3>
      <AreaChart data={rows} xDataKey="date" aspectRatio="2.6 / 1" margin={{ top: 12, right: 20, bottom: 34, left: 40 }}>
        <Grid />
        {G_ORDER.map(g => <Area key={g} dataKey={g} fill={data.state_group_info[g].color} fillOpacity={0.45} />)}
        <XAxis numTicks={5} />
        <ChartTooltip />
      </AreaChart>
    </div>
  );
};

/** Portfolio-based rows shared by Version / Epic reports. */
function portfolioRows(data: DashboardData): { name: string; b: NonNullable<DashboardData['portfolios']>[number]['breakdown']; target?: string }[] {
  return (data.portfolios || []).map(p => ({ name: p.name, b: p.breakdown, target: p.target_date }))
    .sort((a, b) => b.b._total - a.b._total);
}

const VersionReport: FC = () => {
  const { data } = useDashboard();
  const rows = useMemo(() => (data ? portfolioRows(data).filter(r => r.target) : []), [data]);
  if (!data) return null;
  return (
    <>
      <ApproxNote>Plane has no version/release entity in this dataset. Showing <strong>portfolios (epics/modules) that have a target date</strong> as release proxies, with progress toward completion.</ApproxNote>
      {rows.length === 0 ? <Empty>No portfolios with a target date.</Empty> : (
        <div className="chart-box">
          <h3>Release progress <span className="approx">portfolios with a target date</span></h3>
          <HBarList rows={rows.slice(0, 14).map(r => ({
            label: r.name, value: r.b._pct, color: '#3B6D11',
            sub: `· due ${r.target?.slice(0, 10) || '—'} · ${r.b._done}/${r.b._workable}`,
          }))} max={100} valueSuffix="%" labelWidth={200} />
        </div>
      )}
    </>
  );
};

const EpicReport: FC = () => {
  const { data } = useDashboard();
  const rows = useMemo<HBarRow[]>(() => (data ? portfolioRows(data).slice(0, 16).map(r => ({
    label: r.name,
    value: r.b._total,
    segments: G_ORDER.filter(g => (r.b[g] || 0) > 0).map(g => ({
      key: GROUP_LABEL[g], value: r.b[g] || 0, color: data.state_group_info[g]?.color || '#888',
    })),
    sub: `· ${r.b._pct}%`,
  })) : []), [data]);
  if (!data) return null;
  if (!rows.length) return <Empty>No portfolios / epics found.</Empty>;
  return (
    <div className="chart-box">
      <h3>Epic progress <span className="approx">status mix per portfolio</span></h3>
      <HBarList rows={rows} labelWidth={200} />
    </div>
  );
};

const ControlChartReport: FC = () => {
  const { data } = useDashboard();
  const { series, mean } = useMemo(() => {
    if (!data) return { series: [] as Record<string, number | Date>[], mean: 0 };
    const byDay = new Map<string, number[]>();
    const all: number[] = [];
    for (const i of data.items) {
      const r = resolvedIso(i);
      const d = daysBetween(i.created_at, i.updated_at);
      if (r && d !== null && d >= 0) { (byDay.get(r) || byDay.set(r, []).get(r)!).push(d); all.push(d); }
    }
    const m = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
    const series = Array.from(byDay.keys()).sort().map(day => {
      const arr = byDay.get(day)!;
      return { date: new Date(day + 'T00:00:00Z'), cycle: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length), mean: Math.round(m) };
    });
    return { series, mean: Math.round(m) };
  }, [data]);
  if (!data) return null;
  if (series.length < 2) return <Empty>Needs more completed items to plot cycle time.</Empty>;
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="violet" label="Mean cycle time" value={mean} suffix="d" sub="created → completed" />
        <Kpi tone="cool" label="Data points" value={series.length} sub="days with completions" />
      </section>
      <div className="chart-box">
        <h3>Cycle time control chart <span className="approx">daily avg vs mean</span></h3>
        <AreaChart data={series} xDataKey="date" aspectRatio="2.6 / 1" margin={{ top: 12, right: 20, bottom: 32, left: 40 }}>
          <Grid />
          <Area dataKey="cycle" fill="#378ADD" fillOpacity={0.3} />
          <Area dataKey="mean" fill="#A32D2D" fillOpacity={0.12} />
          <XAxis numTicks={6} />
          <ChartTooltip />
        </AreaChart>
      </div>
    </>
  );
};

const EpicBurndownReport: FC = () => {
  const { data } = useDashboard();
  const rows = useMemo<HBarRow[]>(() => (data ? portfolioRows(data)
    .map(r => ({ label: r.name, value: Math.max(0, r.b._workable - r.b._done), sub: `· of ${r.b._workable}`, color: '#A32D2D' }))
    .filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 16) : []), [data]);
  if (!data) return null;
  if (!rows.length) return <Empty>No remaining work in any portfolio.</Empty>;
  return (
    <div className="chart-box">
      <h3>Remaining work per epic <span className="approx">workable − done</span></h3>
      <HBarList rows={rows} labelWidth={200} />
    </div>
  );
};

const ReleaseBurndownReport: FC = () => {
  const { data } = useDashboard();
  const rows = useMemo<HBarRow[]>(() => {
    if (!data) return [];
    const byMonth = new Map<string, number>();
    for (const p of data.portfolios || []) {
      const month = p.target_date ? p.target_date.slice(0, 7) : 'No target';
      byMonth.set(month, (byMonth.get(month) || 0) + Math.max(0, p.breakdown._workable - p.breakdown._done));
    }
    return Array.from(byMonth, ([label, value]) => ({ label, value, color: '#EF9F27' }))
      .filter(r => r.value > 0).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);
  if (!data) return null;
  return (
    <>
      <ApproxNote>No release objects in this dataset. Grouping <strong>portfolios by target month</strong> and summing remaining work as a release burndown.</ApproxNote>
      {rows.length === 0 ? <Empty>No remaining work with target dates.</Empty> : (
        <div className="chart-box">
          <h3>Remaining work by target month</h3>
          <HBarList rows={rows} labelWidth={140} />
        </div>
      )}
    </>
  );
};

const CYCLE_DAYS = 14;

interface UCycle { key: string; label: string; start?: string; end?: string; id?: string; real: boolean; }

/** Real Plane cycles from the cache (sorted by start date, undated last). */
function realCycles(data: DashboardData): UCycle[] {
  const out = (data.cycles || []).filter(c => c.id).map(c => ({
    key: c.id, id: c.id, real: true,
    start: c.start_date ? c.start_date.slice(0, 10) : undefined,
    end: c.end_date ? c.end_date.slice(0, 10) : undefined,
    label: c.name + (c.start_date && c.end_date ? ` · ${fmtShortDate(c.start_date)} – ${fmtShortDate(c.end_date)}` : ''),
  }));
  out.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
  return out;
}

/** Synthetic cycles: split the window into 14-day iterations (oldest first). */
function syntheticCycles(data: DashboardData): UCycle[] {
  const start = windowStart(data);
  const days = eachDay(start, data.today);
  const out: UCycle[] = [];
  for (let i = 0; i < days.length; i += CYCLE_DAYS) {
    const chunk = days.slice(i, i + CYCLE_DAYS);
    const s = chunk[0], e = chunk[chunk.length - 1];
    out.push({ key: `syn-${out.length + 1}`, real: false, start: s, end: e,
      label: `Cycle ${out.length + 1} · ${fmtShortDate(s)} – ${fmtShortDate(e)}` });
  }
  return out;
}

const CycleReport: FC = () => {
  const { data } = useDashboard();
  const cycles = useMemo(() => {
    if (!data) return [] as UCycle[];
    const real = realCycles(data);
    return real.length ? real : syntheticCycles(data);
  }, [data]);
  const isReal = cycles.length > 0 && cycles[0].real;

  // Default = the ACTIVE cycle (today within its dates), else the most recent.
  const activeKey = useMemo(() => {
    if (!data) return null;
    const a = cycles.find(c => c.start && c.end && data.today >= c.start && data.today <= c.end);
    return (a || cycles[cycles.length - 1])?.key ?? null;
  }, [cycles, data]);
  const [sel, setSel] = useState<string | null>(null);
  const cycle = cycles.find(c => c.key === (sel ?? activeKey)) || cycles[cycles.length - 1];

  const stats = useMemo(() => {
    if (!data || !cycle) return null;
    const committed = data.items.filter(i => {
      if (i.state_group === 'cancelled') return false;
      if (cycle.real) return i.cycle_id === cycle.id;         // explicit cycle membership
      // Synthetic: created by cycle end, not already resolved before it started.
      const c = createdIso(i); if (!c || (cycle.end && c > cycle.end)) return false;
      const r = resolvedIso(i); if (r && cycle.start && r < cycle.start) return false;
      return true;
    });
    const completedInCycle = (i: WorkItem) => {
      const r = resolvedIso(i);
      if (cycle.start && cycle.end) return !!r && r >= cycle.start && r <= cycle.end;
      return i.state_group === 'completed';                   // real cycle without dates
    };
    const done = committed.filter(completedInCycle).length;
    const m = new Map<string, { done: number; open: number }>();
    for (const i of committed) {
      const who = i.assignee || 'Unassigned';
      const rec = m.get(who) || { done: 0, open: 0 };
      if (completedInCycle(i)) rec.done++; else rec.open++;
      m.set(who, rec);
    }
    const byPerson: HBarRow[] = Array.from(m, ([label, r]) => ({
      label, value: r.done + r.open,
      segments: [
        { key: 'Completed', value: r.done, color: '#3B6D11' },
        { key: 'Carried over', value: r.open, color: '#B8B4A8' },
      ].filter(s => s.value > 0),
    })).sort((a, b) => b.value - a.value);
    return { committed: committed.length, done, byPerson };
  }, [data, cycle]);

  if (!data) return null;
  if (!cycle || !stats) return <Empty>No cycles in the window.</Empty>;
  const rate = stats.committed ? Math.round((100 * stats.done) / stats.committed) : 0;
  const isActive = cycle.key === activeKey;
  return (
    <>
      {isReal
        ? <div className="text-xs text-muted-foreground mb-3">Live Plane cycles · scoped by cycle membership. Defaults to the active cycle.</div>
        : <ApproxNote>This project has no Plane cycles cached, so cycles are <strong>synthesised as {CYCLE_DAYS}-day iterations</strong> across the window. Refresh the project to load real cycles. Defaults to the active cycle.</ApproxNote>}
      <div className="mb-3 flex items-center gap-2">
        <select
          value={cycle.key}
          onChange={e => setSel(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-md border border-border bg-card text-foreground outline-none focus:border-ring max-w-full"
        >
          {cycles.slice().reverse().map(c => (
            <option key={c.key} value={c.key}>{c.label}{c.key === activeKey ? ' · active' : ''}</option>
          ))}
        </select>
        {isActive && <span className="text-[11px] font-medium text-green-700 dark:text-green-300 bg-green-500/15 rounded-full px-2 py-0.5">Active cycle</span>}
      </div>
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Kpi tone="cool" label="Committed" value={stats.committed} sub="in cycle scope" />
        <Kpi tone="good" label="Completed" value={stats.done} sub={cycle.start && cycle.end ? 'resolved in cycle' : 'completed'} />
        <Kpi tone="bad" label="Carried over" value={stats.committed - stats.done} sub="not finished" />
        <Kpi tone="violet" label="Completion" value={rate} suffix="%" sub="of scope" />
      </section>
      <div className="chart-box">
        <h3>Per assignee <span className="approx">completed vs carried over</span></h3>
        <HBarList rows={stats.byPerson.slice(0, 16)} labelWidth={180} empty="No work in this cycle." />
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// ISSUE ANALYSIS reports
// ---------------------------------------------------------------------------

const AverageAgeReport: FC = () => {
  const { data } = useDashboard();
  const { avg, rows, count } = useMemo(() => {
    if (!data) return { avg: 0, rows: [] as HBarRow[], count: 0 };
    const today = data.today;
    const byType = new Map<string, number[]>();
    const all: number[] = [];
    for (const i of data.items) {
      if (!isOpen(i)) continue;
      const age = daysBetween(i.created_at, today + 'T00:00:00Z');
      if (age === null || age < 0) continue;
      all.push(age);
      const t = i.type || 'Other';
      (byType.get(t) || byType.set(t, []).get(t)!).push(age);
    }
    const avg = all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : 0;
    const rows: HBarRow[] = Array.from(byType, ([label, arr]) => ({
      label, value: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
      color: TYPE_COLORS[label] || '#888780', sub: `(n=${arr.length})`,
    })).sort((a, b) => b.value - a.value);
    return { avg, rows, count: all.length };
  }, [data]);
  if (!data) return null;
  if (!count) return <Empty>No open items in the window.</Empty>;
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="bad" label="Average age" value={avg} suffix="d" sub="of open items" />
        <Kpi tone="cool" label="Open items" value={count} sub="unresolved" />
      </section>
      <div className="chart-box">
        <h3>Average age by type <span className="approx">days since created · open only</span></h3>
        <HBarList rows={rows} valueSuffix="d" />
      </div>
    </>
  );
};

const CreatedVsResolvedReport: FC = () => {
  const { data } = useDashboard();
  const series = useMemo(() => (data ? flowSeries(data) : []), [data]);
  if (!data) return null;
  if (series.length < 2) return <Empty />;
  const last = series[series.length - 1];
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="cool" label="Created" value={last.createdCum} sub="in window" />
        <Kpi tone="good" label="Resolved" value={last.resolvedCum} sub="in window" />
        <Kpi tone={last.remaining > 0 ? 'bad' : 'good'} label="Net open" value={last.remaining} sub={last.remaining > 0 ? 'backlog grew' : 'backlog shrank'} />
      </section>
      <div className="chart-box">
        <h3>Created vs resolved (cumulative)</h3>
        <AreaChart data={series} xDataKey="date" aspectRatio="2.6 / 1" margin={{ top: 12, right: 20, bottom: 32, left: 40 }}>
          <Grid />
          <Area dataKey="createdCum" fill="#378ADD" fillOpacity={0.25} />
          <Area dataKey="resolvedCum" fill="#3B6D11" fillOpacity={0.4} />
          <XAxis numTicks={6} />
          <ChartTooltip />
        </AreaChart>
      </div>
    </>
  );
};

const PIE_COLORS: Record<Field, (label: string, data: DashboardData) => string | undefined> = {
  state_group: () => undefined,
  priority: (l) => Object.values(PRIORITY_INFO).find(p => p.label === l)?.color,
  type: (l) => TYPE_COLORS[l],
  assignee: () => undefined,
};

const PieChartReport: FC = () => {
  const { data } = useDashboard();
  const [field, setField] = useState<Field>('state_group');
  const slices = useMemo(() => {
    if (!data) return [];
    return groupBy(data.items, field).slice(0, 8).map((g, idx) => ({
      label: g.label, value: g.value,
      color: (field === 'state_group'
        ? data.state_group_info[Object.keys(GROUP_LABEL).find(k => GROUP_LABEL[k as StateGroup] === g.label) as StateGroup]?.color
        : PIE_COLORS[field](g.label, data)) || PALETTE[idx % PALETTE.length],
    }));
  }, [data, field]);
  if (!data) return null;
  return (
    <>
      <FieldPicker value={field} onChange={setField} />
      {slices.length === 0 ? <Empty /> : (
        <div className="chart-box">
          <h3>Work items by {FIELD_OPTS.find(o => o.key === field)?.label.toLowerCase()}</h3>
          <div className="flex flex-wrap items-center justify-center gap-8" style={{ minHeight: 240 }}>
            <PieChart data={slices} innerRadius={70} padAngle={0.02} cornerRadius={3} className="max-w-[240px]">
              {slices.map((_, i) => <PieSlice key={i} index={i} hoverEffect="grow" />)}
              <PieCenter>
                {() => (
                  <div className="text-center">
                    <div className="text-2xl font-medium">{slices.reduce((a, d) => a + d.value, 0)}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">items</div>
                  </div>
                )}
              </PieCenter>
            </PieChart>
            <ul className="text-sm space-y-1.5">
              {slices.map(s => (
                <li key={s.label} className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
                  <span className="text-foreground">{s.label}</span>
                  <span className="text-muted-foreground tabular-nums">{s.value}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
};

const RecentlyCreatedReport: FC = () => {
  const { data } = useDashboard();
  const { bars, total } = useMemo(() => {
    if (!data) return { bars: [] as { name: string; count: number }[], total: 0 };
    const today = new Date(data.today + 'T00:00:00Z');
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - 29);
    const startIso = start.toISOString().slice(0, 10);
    const byDay = new Map<string, number>();
    let total = 0;
    for (const i of data.items) {
      const c = createdIso(i);
      if (c && c >= startIso) { byDay.set(c, (byDay.get(c) || 0) + 1); total++; }
    }
    const bars = eachDay(startIso, data.today).map(d => ({ name: d.slice(5), count: byDay.get(d) || 0 }));
    return { bars, total };
  }, [data]);
  if (!data) return null;
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="cool" label="Created (30d)" value={total} sub="new items" />
        <Kpi tone="good" label="Per day" value={Math.round((total / 30) * 10) / 10} sub="average" />
      </section>
      <div className="chart-box">
        <h3>Recently created <span className="approx">last 30 days</span></h3>
        {total === 0 ? <Empty /> : (
          <BarChart data={bars} xDataKey="name" aspectRatio="3.4 / 1" margin={{ top: 12, right: 16, bottom: 30, left: 36 }}>
            <Grid />
            <Bar dataKey="count" fill="#378ADD" />
            <ChartTooltip />
          </BarChart>
        )}
      </div>
    </>
  );
};

const RESOLUTION_BUCKETS: { label: string; test: (d: number) => boolean }[] = [
  { label: '0–1d', test: d => d <= 1 },
  { label: '2–3d', test: d => d <= 3 },
  { label: '4–7d', test: d => d <= 7 },
  { label: '8–14d', test: d => d <= 14 },
  { label: '15–30d', test: d => d <= 30 },
  { label: '31–60d', test: d => d <= 60 },
  { label: '60d+', test: () => true },
];

const ResolutionTimeReport: FC = () => {
  const { data } = useDashboard();
  const { bars, median, n } = useMemo(() => {
    if (!data) return { bars: [] as { name: string; count: number }[], median: 0, n: 0 };
    const counts = RESOLUTION_BUCKETS.map(() => 0);
    const all: number[] = [];
    for (const i of data.items) {
      if (i.state_group !== 'completed') continue;
      const d = daysBetween(i.created_at, i.updated_at);
      if (d === null || d < 0) continue;
      all.push(d);
      counts[RESOLUTION_BUCKETS.findIndex(b => b.test(d))]++;
    }
    all.sort((a, b) => a - b);
    const median = all.length ? all[Math.floor(all.length / 2)] : 0;
    return { bars: RESOLUTION_BUCKETS.map((b, idx) => ({ name: b.label, count: counts[idx] })), median, n: all.length };
  }, [data]);
  if (!data) return null;
  if (!n) return <Empty>No completed items to measure.</Empty>;
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="violet" label="Median resolution" value={median} suffix="d" sub="created → completed" />
        <Kpi tone="cool" label="Resolved" value={n} sub="items measured" />
      </section>
      <div className="chart-box">
        <h3>Resolution time distribution</h3>
        <BarChart data={bars} xDataKey="name" aspectRatio="2.8 / 1" margin={{ top: 12, right: 16, bottom: 30, left: 36 }}>
          <Grid />
          <Bar dataKey="count" fill="#8280FF" />
          <ChartTooltip />
        </BarChart>
      </div>
    </>
  );
};

const GroupByReport: FC = () => {
  const { data } = useDashboard();
  const [field, setField] = useState<Field>('assignee');
  const rows = useMemo(() => (data ? groupByStacked(data.items, field, data) : []), [data, field]);
  if (!data) return null;
  return (
    <>
      <FieldPicker value={field} onChange={setField} />
      {rows.length === 0 ? <Empty /> : (
        <div className="chart-box">
          <h3>Grouped by {FIELD_OPTS.find(o => o.key === field)?.label.toLowerCase()} <span className="approx">status mix per group</span></h3>
          <HBarList rows={rows.slice(0, 20)} labelWidth={180} />
        </div>
      )}
    </>
  );
};

const SINCE_BUCKETS: { label: string; test: (d: number) => boolean; color: string }[] = [
  { label: '< 1 day', test: d => d < 1, color: '#3B6D11' },
  { label: '1–7 days', test: d => d <= 7, color: '#378ADD' },
  { label: '8–30 days', test: d => d <= 30, color: '#EF9F27' },
  { label: '31–90 days', test: d => d <= 90, color: '#EF5974' },
  { label: '90 days+', test: () => true, color: '#A32D2D' },
];

const TimeSinceReport: FC = () => {
  const { data } = useDashboard();
  const { bars, n } = useMemo(() => {
    if (!data) return { bars: [] as { name: string; count: number }[], n: 0 };
    const today = data.today + 'T00:00:00Z';
    const counts = SINCE_BUCKETS.map(() => 0);
    let n = 0;
    for (const i of data.items) {
      if (!isOpen(i)) continue;
      const d = daysBetween(i.updated_at, today);
      if (d === null || d < 0) continue;
      counts[SINCE_BUCKETS.findIndex(b => b.test(d))]++;
      n++;
    }
    return { bars: SINCE_BUCKETS.map((b, idx) => ({ name: b.label, count: counts[idx] })), n };
  }, [data]);
  if (!data) return null;
  if (!n) return <Empty>No open items in the window.</Empty>;
  const stale = bars.slice(2).reduce((a, b) => a + b.count, 0);
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Kpi tone="cool" label="Open items" value={n} sub="unresolved" />
        <Kpi tone="bad" label="Idle 30d+" value={stale} sub="no recent update" />
      </section>
      <div className="chart-box">
        <h3>Time since last update <span className="approx">open items · by staleness</span></h3>
        <BarChart data={bars} xDataKey="name" aspectRatio="2.8 / 1" margin={{ top: 12, right: 16, bottom: 30, left: 36 }}>
          <Grid />
          <Bar dataKey="count" fill="#EF9F27" />
          <ChartTooltip />
        </BarChart>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// KPI card (matches the app's .kpi styling)
// ---------------------------------------------------------------------------

function Kpi({ tone, label, value, sub, suffix }: {
  tone: 'good' | 'violet' | 'cool' | 'bad'; label: string; value: number; sub?: string; suffix?: string;
}) {
  return (
    <div className={'kpi kpi-' + tone}>
      <div className="kpi-label"><span className="kpi-dot" />{label}</div>
      <div className="kpi-value">{value}{suffix && <span className="text-base text-muted-foreground font-normal ml-0.5">{suffix}</span>}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry + gallery
// ---------------------------------------------------------------------------

interface ReportDef {
  key: string;
  section: 'Agile' | 'Work items';
  title: string;
  desc: string;
  info: string;
  Icon: LucideIcon;
  Widget: FC;
}

const REPORTS: ReportDef[] = [
  { key: 'burndown', section: 'Agile', title: 'Burndown Chart', desc: 'Track remaining open work over the window against an ideal guideline to spot slippage.', Icon: TrendingUp, Widget: BurndownReport,
    info: 'Shows how much work is still open on each day of the window. For every day we count cumulative created minus cumulative completed (a work item counts as completed on its updated_at once it reaches a completed state). The grey line is the “ideal” — a straight run-down from the starting open count to zero. The real line sitting above ideal means work is accumulating faster than it’s finished.' },
  { key: 'burnup', section: 'Agile', title: 'Burnup Chart', desc: 'Scope vs completed over time, so scope growth is visible alongside progress.', Icon: LineChartIcon, Widget: BurnupReport,
    info: 'Two cumulative lines over the window: total scope (all work items created so far) and completed (items reaching a completed state). The gap between them is remaining work. A rising scope line reveals scope creep that a burndown alone would hide. Completion % = completed ÷ scope.' },
  { key: 'cycle', section: 'Agile', title: 'Cycle Report', desc: 'Committed, completed and carry-over for a chosen cycle — defaults to the active one.', Icon: Rocket, Widget: CycleReport,
    info: 'When the project has real Plane cycles cached, committed = work items assigned to the selected cycle (by cycle membership); otherwise cycles are synthesised as 14-day iterations and committed = items that existed during that window. Completed = committed items that reached a completed state within the cycle’s dates. Carried over = committed minus completed. Completion % = completed ÷ committed. Defaults to the active cycle (today within its dates).' },
  { key: 'velocity', section: 'Agile', title: 'Velocity Report', desc: 'Completed work per week to gauge and forecast the team’s delivery rate.', Icon: Gauge, Widget: VelocityReport,
    info: 'Counts work items completed in each ISO week (bucketed by the completion date) for the last 12 weeks. Avg velocity is the mean of those weekly counts; best week is the peak. Use it to forecast how much the team can take on next.' },
  { key: 'cfd', section: 'Agile', title: 'Cumulative Flow Diagram', desc: 'Status mix over refresh snapshots — watch WIP and bottlenecks build up.', Icon: Layers, Widget: CfdReport,
    info: 'A stacked area of how many work items sat in each status group (completed / in progress / unstarted / backlog / cancelled) at each data refresh. Widening bands are growing WIP; a bulge in one band signals a bottleneck. Needs at least two refresh snapshots to draw.' },
  { key: 'version', section: 'Agile', title: 'Version Report', desc: 'Progress of portfolios with target dates, used as release proxies.', Icon: Milestone, Widget: VersionReport,
    info: 'Per portfolio (epic/module) that has a target date, the bar shows completion % = done ÷ workable items, with the target date and done/total counts. Plane “versions/releases” aren’t in this dataset, so portfolios-with-a-target-date stand in as release proxies.' },
  { key: 'epic', section: 'Agile', title: 'Epic Report', desc: 'Status breakdown per portfolio/epic to see where each one stands.', Icon: ListChecks, Widget: EpicReport,
    info: 'One row per portfolio/epic; the bar is split into the count of its child work items by status group (completed / in progress / unstarted / backlog / cancelled). The % suffix is the portfolio’s completion. Sorted by total size.' },
  { key: 'control', section: 'Agile', title: 'Control Chart', desc: 'Cycle time of completed items over time versus the rolling mean.', Icon: Activity, Widget: ControlChartReport,
    info: 'For each completed work item, cycle time = days from created to completed. We plot the average cycle time of items completed on each day (blue) against the overall mean (red). Points drifting above the mean mean work is taking longer than usual.' },
  { key: 'epic-burndown', section: 'Agile', title: 'Epic Burndown', desc: 'Remaining workable items per epic, to track epics toward done.', Icon: Flame, Widget: EpicBurndownReport,
    info: 'For each portfolio/epic, remaining = workable items minus done items (backlog and cancelled are excluded from “workable”). Bars are sorted by most remaining, so the epics furthest from done sit on top.' },
  { key: 'release-burndown', section: 'Agile', title: 'Release Burndown', desc: 'Remaining work grouped by portfolio target month as a release view.', Icon: Target, Widget: ReleaseBurndownReport,
    info: 'Groups portfolios by their target month and sums remaining work (workable minus done) per month. Since Plane releases aren’t in the cache, portfolio target dates stand in for release dates. Read it as “how much is still owed before each target month”.' },
  { key: 'avg-age', section: 'Work items', title: 'Average Age Report', desc: 'How old, on average, unresolved items are — broken down by type.', Icon: Hourglass, Widget: AverageAgeReport,
    info: 'Age = days from created to today, measured only for open work items (not completed, not cancelled). The KPI is the overall average; the bars break the average age down by work-item type, with n = how many open items of that type.' },
  { key: 'created-resolved', section: 'Work items', title: 'Created vs Resolved', desc: 'Cumulative created against resolved to see if the backlog is growing.', Icon: TrendingUp, Widget: CreatedVsResolvedReport,
    info: 'Two cumulative lines across the window: work items created and work items resolved (reaching a completed state). If created outpaces resolved the gap — net open — grows, meaning the backlog is expanding faster than the team clears it.' },
  { key: 'pie', section: 'Work items', title: 'Pie Chart Report', desc: 'Distribution of work items by status, priority, type or assignee.', Icon: PieChartIcon, Widget: PieChartReport,
    info: 'Counts work items in the current window grouped by the field you pick (status / priority / type / assignee) and shows each group’s share of the total. The top 8 groups are shown; the centre number is the total counted.' },
  { key: 'recent', section: 'Work items', title: 'Recently Created Work Items', desc: 'New items per day over the last 30 days to see intake trends.', Icon: CalendarClock, Widget: RecentlyCreatedReport,
    info: 'Counts work items by their created date for each of the last 30 days (relative to the data’s “today”). A zero-height day genuinely had no new work items created. “Per day” is the 30-day total ÷ 30.' },
  { key: 'resolution', section: 'Work items', title: 'Resolution Time Report', desc: 'How long items take from created to completed, as a distribution.', Icon: Clock, Widget: ResolutionTimeReport,
    info: 'For every completed work item, resolution time = days from created to completed. Items are bucketed (0–1d, 2–3d, … 60d+) and the bars show how many fell in each bucket. Median is the middle value across all resolved items.' },
  { key: 'group-by', section: 'Work items', title: 'Single Level Group By', desc: 'Group work items by any field and see the status mix within each group.', Icon: BarChart3, Widget: GroupByReport,
    info: 'Groups all work items in the window by the field you pick (assignee / status / priority / type). Each bar’s length is the group’s total count, split into segments by status group so you can see the mix within each group. Sorted largest first, top 20 shown.' },
  { key: 'time-since', section: 'Work items', title: 'Time Since Update', desc: 'Open items bucketed by how long since their last update — find stale work.', Icon: History, Widget: TimeSinceReport,
    info: 'For open work items only, we measure days since the last update (updated_at) and bucket them (<1d, 1–7d, 8–30d, 31–90d, 90d+). The “idle 30d+” KPI sums the last two buckets — work that hasn’t moved in over a month.' },
];

function ReportBlock({ r, expanded, onToggle }: { r: ReportDef; expanded: boolean; onToggle: () => void }) {
  const W = r.Widget;
  const [showInfo, setShowInfo] = useState(false);
  return (
    <section id={`report-${r.key}`}
      className="scroll-mt-4 mb-4 break-inside-avoid rounded-lg border border-border bg-card p-4"
      style={{ columnSpan: expanded ? 'all' : undefined } as React.CSSProperties}>
      <div className="flex items-start gap-2.5 mb-3">
        <span className="grid place-items-center h-8 w-8 rounded-md bg-muted text-foreground shrink-0"><r.Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold leading-tight">{r.title}</h3>
          <p className="text-xs text-muted-foreground truncate">{r.desc}</p>
        </div>
        <button type="button" onClick={() => setShowInfo(v => !v)}
          title="What this means & how it's calculated"
          aria-pressed={showInfo}
          className={'shrink-0 grid place-items-center h-7 w-7 rounded-md transition-colors ' +
            (showInfo ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent')}>
          <Info className="h-4 w-4" />
        </button>
        <button type="button" onClick={onToggle}
          title={expanded ? 'Collapse to half width' : 'Expand to full width'}
          className="shrink-0 grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
      {showInfo && (
        <div className="mb-3 text-xs leading-relaxed text-muted-foreground bg-muted/40 border border-border rounded-md px-3 py-2">
          {r.info}
        </div>
      )}
      <W />
    </section>
  );
}

export function ReportsView() {
  const { data, status } = useDashboard();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (status === 'loading' || status === 'fetching') {
    return <div className="text-sm text-muted-foreground p-4">Loading…</div>;
  }
  if (!data) return <div className="text-sm text-muted-foreground p-4">No data.</div>;

  const sections: ReportDef['section'][] = ['Agile', 'Work items'];
  return (
    <div className="space-y-8">
      {sections.map(sec => (
        <div key={sec}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-4 pb-1.5 border-b border-border">{sec}</h2>
          <div className="columns-1 lg:columns-2 gap-4">
            {REPORTS.filter(r => r.section === sec).map(r => (
              <ReportBlock key={r.key} r={r} expanded={expanded.has(r.key)} onToggle={() => toggle(r.key)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
