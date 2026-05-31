import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Minus, Activity } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { PRIORITY_INFO, TYPE_COLORS } from '@/lib/constants';
import { isoWeekStart, thirtyDaysAgoIso } from '@/lib/format';
import type { ActionBucketKey, Priority, StateGroup, WorkItem } from '@/lib/types';
import { WorkItemListModal } from '@/components/WorkItemListModal';
import { AreaChart } from '@/components/charts/area-chart';
import { Area } from '@/components/charts/area';
import { BarChart } from '@/components/charts/bar-chart';
import { Bar } from '@/components/charts/bar';
import { Grid } from '@/components/charts/grid';
import { XAxis } from '@/components/charts/x-axis';
import { ChartTooltip } from '@/components/charts/tooltip/chart-tooltip';
import { PieChart } from '@/components/charts/pie-chart';
import { PieSlice } from '@/components/charts/pie-slice';
import { PieCenter } from '@/components/charts/pie-center';
import { HBarList } from '@/components/HBarList';
import { RiskStrip } from '@/components/RiskStrip';

const VELOCITY_WEEKS = 12;
const VELOCITY_MONTHS = 6;
type VelocityView = 'week' | 'month';

interface VelocityBucket {
  label: string;
  count: number;
  isCurrent: boolean;
}
interface VelocityStats {
  buckets: VelocityBucket[];
  headline: number;        // rolling avg of last N complete buckets
  windowSize: number;      // how many complete buckets averaged for headline
  trend: 'up' | 'down' | 'flat';
  trendPct: number;
  trendLabel: string;
  lastComplete: number;
  current: number;
  best: number;
  stddev: number;
  stability: 'Stable' | 'Variable' | 'Volatile';
  unit: 'wk' | 'mo';
}

function classifyTrend(last: number, prev: number): { trend: 'up' | 'down' | 'flat'; trendPct: number } {
  const trendPct = prev > 0 ? Math.round(100 * (last - prev) / prev) : (last > 0 ? 100 : 0);
  const trend: 'up' | 'down' | 'flat' = Math.abs(trendPct) <= 5 ? 'flat' : (trendPct > 0 ? 'up' : 'down');
  return { trend, trendPct };
}
function classifyStability(stddev: number, mean: number): VelocityStats['stability'] {
  if (mean <= 0) return 'Stable';
  const cv = stddev / mean;
  if (cv < 0.25) return 'Stable';
  if (cv < 0.55) return 'Variable';
  return 'Volatile';
}

const G_ORDER: StateGroup[] = ['completed', 'started', 'unstarted', 'backlog', 'cancelled'];
const P_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

type DrillKey = 'wip' | 'completed' | 'created' | 'risk';

interface Drill {
  key: DrillKey;
  title: string;
  subtitle?: string;
  items: WorkItem[];
}

export function PulseView({ onJump }: { onJump: (k: ActionBucketKey) => void }) {
  const { data, actions, currentProject } = useDashboard();
  const [velocityView, setVelocityView] = useState<VelocityView>('week');
  const [drill, setDrill] = useState<Drill | null>(null);
  if (!data) return <div className="text-sm text-muted-foreground p-4">No data.</div>;

  const items = data.items;
  const wip = items.filter(i => i.state_group === 'started').length;
  const unstarted = items.filter(i => i.state_group === 'unstarted').length;
  const since = thirtyDaysAgoIso(data.today);
  const created30 = items.filter(i => (i.created_at || '').slice(0, 10) >= since).length;
  const done30 = items.filter(i => i.state_group === 'completed' && (i.updated_at || '').slice(0, 10) >= since).length;
  const net = created30 - done30;
  const risk = (actions?.past_due.items.length || 0) + (actions?.aging_wip.items.length || 0);
  const pastDueCount = actions?.past_due.items.length || 0;
  const agingCount = actions?.aging_wip.items.length || 0;

  const stateDonutData = useMemo(() => G_ORDER
    .map(g => ({
      label: data.state_group_info[g].label,
      value: data.group_counts[g] || 0,
      color: data.state_group_info[g].color,
    }))
    .filter(d => d.value > 0), [data]);

  const priorityRows = useMemo(() => P_ORDER.map(p => ({
    label: PRIORITY_INFO[p].label,
    value: data.priority_counts[p] || 0,
    color: PRIORITY_INFO[p].color,
  })), [data]);

  const typeRows = useMemo(() => Object.entries(data.type_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => ({
      label: t,
      value: n,
      color: TYPE_COLORS[t] || '#888780',
    })), [data]);

  // ---------- Velocity: weekly + monthly views ----------
  // Headline averages the last N COMPLETE buckets (excluding the in-progress
  // current bucket) so the partial week/month doesn't drag the number down.
  const velocityWeek = useMemo<VelocityStats>(() => {
    const today = new Date(data.today + 'T00:00:00Z');
    const buckets: Array<{ date: Date; label: string; count: number; isCurrent: boolean }> = [];
    const dow = today.getUTCDay();
    const offsetToMon = dow === 0 ? -6 : 1 - dow;
    const thisMonday = new Date(today);
    thisMonday.setUTCDate(today.getUTCDate() + offsetToMon);
    for (let i = VELOCITY_WEEKS - 1; i >= 0; i--) {
      const wkStart = new Date(thisMonday);
      wkStart.setUTCDate(thisMonday.getUTCDate() - i * 7);
      buckets.push({
        date: wkStart,
        label: wkStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        count: 0,
        isCurrent: i === 0,
      });
    }
    const earliest = buckets[0].date.getTime();
    const latestEnd = thisMonday.getTime() + 7 * 86400000;
    for (const item of data.items) {
      if (item.state_group !== 'completed' || !item.updated_at) continue;
      const t = new Date(item.updated_at).getTime();
      if (t < earliest || t >= latestEnd) continue;
      const idx = Math.floor((t - earliest) / (7 * 86400000));
      if (idx >= 0 && idx < buckets.length) buckets[idx].count++;
    }
    const counts = buckets.map(b => b.count);
    const completed = counts.slice(0, -1);
    const last4 = completed.slice(-4);
    const prev4 = completed.slice(-8, -4);
    const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0);
    const last4Avg = last4.length ? sum(last4) / last4.length : 0;
    const prev4Avg = prev4.length ? sum(prev4) / prev4.length : 0;
    const { trend, trendPct } = classifyTrend(last4Avg, prev4Avg);
    const meanForVar = completed.length ? sum(completed) / completed.length : 0;
    const variance = completed.length ? completed.reduce((s, n) => s + (n - meanForVar) ** 2, 0) / completed.length : 0;
    const stddev = Math.sqrt(variance);
    return {
      buckets: buckets.map(b => ({ label: b.label, count: b.count, isCurrent: b.isCurrent })),
      headline: Math.round(last4Avg),
      windowSize: 4,
      trend, trendPct, trendLabel: 'vs prior 4w',
      lastComplete: completed.length ? completed[completed.length - 1] : 0,
      current: counts[counts.length - 1] || 0,
      best: counts.length ? Math.max(...counts) : 0,
      stddev: Math.round(stddev),
      stability: classifyStability(stddev, meanForVar),
      unit: 'wk',
    };
  }, [data]);

  const velocityMonth = useMemo<VelocityStats>(() => {
    const today = new Date(data.today + 'T00:00:00Z');
    type Bucket = { startTs: number; endTs: number; label: string; count: number; isCurrent: boolean };
    const buckets: Bucket[] = [];
    // First day of the current month, then walk back N-1 months.
    for (let i = VELOCITY_MONTHS - 1; i >= 0; i--) {
      const start = new Date(today);
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCMonth(start.getUTCMonth() - i);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const isJan = start.getUTCMonth() === 0;
      const yearTag = (i === 0 || isJan) ? ' ' + String(start.getUTCFullYear()).slice(2) : '';
      buckets.push({
        startTs: start.getTime(),
        endTs: end.getTime(),
        label: start.toLocaleDateString('en-US', { month: 'short' }) + yearTag,
        count: 0,
        isCurrent: i === 0,
      });
    }
    const earliest = buckets[0].startTs;
    const latestEnd = buckets[buckets.length - 1].endTs;
    for (const item of data.items) {
      if (item.state_group !== 'completed' || !item.updated_at) continue;
      const t = new Date(item.updated_at).getTime();
      if (t < earliest || t >= latestEnd) continue;
      // Find the bucket via linear scan (max VELOCITY_MONTHS = small).
      for (const b of buckets) {
        if (t >= b.startTs && t < b.endTs) { b.count++; break; }
      }
    }
    const counts = buckets.map(b => b.count);
    const completed = counts.slice(0, -1);
    const last3 = completed.slice(-3);
    const prev3 = completed.slice(-6, -3);
    const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0);
    const last3Avg = last3.length ? sum(last3) / last3.length : 0;
    const prev3Avg = prev3.length ? sum(prev3) / prev3.length : 0;
    const { trend, trendPct } = classifyTrend(last3Avg, prev3Avg);
    const meanForVar = completed.length ? sum(completed) / completed.length : 0;
    const variance = completed.length ? completed.reduce((s, n) => s + (n - meanForVar) ** 2, 0) / completed.length : 0;
    const stddev = Math.sqrt(variance);
    return {
      buckets: buckets.map(b => ({ label: b.label, count: b.count, isCurrent: b.isCurrent })),
      headline: Math.round(last3Avg),
      windowSize: 3,
      trend, trendPct, trendLabel: 'vs prior 3mo',
      lastComplete: completed.length ? completed[completed.length - 1] : 0,
      current: counts[counts.length - 1] || 0,
      best: counts.length ? Math.max(...counts) : 0,
      stddev: Math.round(stddev),
      stability: classifyStability(stddev, meanForVar),
      unit: 'mo',
    };
  }, [data]);

  const velocity = velocityView === 'week' ? velocityWeek : velocityMonth;

  // Created vs Resolved per week — both series computed from items so the chart
  // matches the Flow tab's throughput math. bklit AreaChart needs real Date
  // objects in xDataKey because it builds an internal scaleTime.
  const flowWeekly = useMemo(() => {
    const created = new Map<string, number>();
    const resolved = new Map<string, number>();
    for (const i of data.items) {
      if (i.created_at) {
        const w = isoWeekStart(i.created_at);
        created.set(w, (created.get(w) || 0) + 1);
      }
      if (i.state_group === 'completed' && i.updated_at) {
        const w = isoWeekStart(i.updated_at);
        resolved.set(w, (resolved.get(w) || 0) + 1);
      }
    }
    const allWeeks = Array.from(new Set([...created.keys(), ...resolved.keys()])).sort();
    return allWeeks.map(w => ({
      date: new Date(w),
      created: created.get(w) || 0,
      resolved: resolved.get(w) || 0,
    }));
  }, [data]);

  // Item lists behind each KPI (built lazily so non-clicked metrics aren't computed).
  const openDrill = (key: DrillKey) => {
    let next: Drill;
    if (key === 'wip') {
      next = {
        key,
        title: 'Active WIP',
        subtitle: 'state group = Started',
        items: items.filter(i => i.state_group === 'started'),
      };
    } else if (key === 'completed') {
      next = {
        key,
        title: 'Completed (last 30 days)',
        subtitle: `completed since ${since}`,
        items: items.filter(i => i.state_group === 'completed' && (i.updated_at || '').slice(0, 10) >= since),
      };
    } else if (key === 'created') {
      next = {
        key,
        title: 'Created (last 30 days)',
        subtitle: `created since ${since}`,
        items: items.filter(i => (i.created_at || '').slice(0, 10) >= since),
      };
    } else {
      const pastDue = actions?.past_due.items || [];
      const aging = actions?.aging_wip.items || [];
      const seen = new Set<string>();
      const combined = [...pastDue, ...aging].filter(i => seen.has(i.id) ? false : (seen.add(i.id), true));
      next = {
        key,
        title: 'At risk',
        subtitle: `${pastDue.length} past due · ${aging.length} aging WIP`,
        items: combined,
      };
    }
    setDrill(next);
  };

  return (
    <div className="space-y-3">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <button type="button" onClick={() => openDrill('wip')} className="kpi kpi-warm kpi-clickable text-left">
          <div className="kpi-label"><span className="kpi-dot" />Active WIP</div>
          <div className="kpi-value">{wip}</div>
          <div className="kpi-sub"><strong>{unstarted}</strong> waiting to start</div>
        </button>
        <button type="button" onClick={() => openDrill('completed')} className="kpi kpi-good kpi-clickable text-left">
          <div className="kpi-label"><span className="kpi-dot" />Completed (30d)</div>
          <div className="kpi-value">{done30}</div>
          <div className="kpi-sub">in the last 30 days</div>
        </button>
        <button type="button" onClick={() => openDrill('created')} className={'kpi kpi-clickable text-left ' + (net > 0 ? 'kpi-bad' : net < 0 ? 'kpi-good' : 'kpi-cool')}>
          <div className="kpi-label"><span className="kpi-dot" />Net flow (30d)</div>
          <div className="kpi-value">{net > 0 ? '+' : ''}{net}</div>
          <div className="kpi-sub">
            {net > 0 ? <span className="neg">backlog growing</span> : net < 0 ? <span className="pos">backlog shrinking</span> : null}
            {net !== 0 && ' · '}
            <strong>{created30}</strong> created · <strong>{done30}</strong> done
          </div>
        </button>
        <button type="button" onClick={() => openDrill('risk')} className={'kpi kpi-clickable text-left ' + (risk > 0 ? 'kpi-bad' : 'kpi-good')}>
          <div className="kpi-label"><span className="kpi-dot" />At risk</div>
          <div className="kpi-value">{risk}</div>
          <div className="kpi-sub"><strong>{pastDueCount}</strong> past due · <strong>{agingCount}</strong> aging</div>
        </button>
      </section>

      <WorkItemListModal
        open={drill !== null}
        onClose={() => setDrill(null)}
        title={drill?.title || ''}
        subtitle={drill?.subtitle}
        items={drill?.items || []}
        currentProject={currentProject}
        meta={data._meta}
      />

      <RiskStrip onJump={onJump} />

      {/* ============ VELOCITY ============ */}
      <section className="velocity-section">
        <div className="velocity-summary">
          <div className="kpi-label"><Activity className="h-3.5 w-3.5" />Velocity</div>
          <div className="velocity-big">
            {velocity.headline}<span className="velocity-unit">/{velocity.unit}</span>
          </div>
          <div className={'velocity-trend velocity-trend-' + velocity.trend}>
            {velocity.trend === 'up'   && <ArrowUp   className="h-3.5 w-3.5" />}
            {velocity.trend === 'down' && <ArrowDown className="h-3.5 w-3.5" />}
            {velocity.trend === 'flat' && <Minus     className="h-3.5 w-3.5" />}
            {velocity.trendPct > 0 ? '+' : ''}{velocity.trendPct}% {velocity.trendLabel}
          </div>
          <div className="velocity-stability">
            <span className={'velocity-pill velocity-pill-' + velocity.stability.toLowerCase()}>{velocity.stability}</span>
            <span className="text-[11px] text-muted-foreground">±{velocity.stddev}/{velocity.unit}</span>
          </div>
          <div className="velocity-meta">
            <div><span className="velocity-meta-label">Last full {velocity.unit === 'wk' ? 'week' : 'month'}</span><strong>{velocity.lastComplete}</strong></div>
            <div><span className="velocity-meta-label">This {velocity.unit === 'wk' ? 'week' : 'month'} so far</span><strong>{velocity.current}</strong></div>
            <div><span className="velocity-meta-label">Best {velocity.unit === 'wk' ? 'week' : 'month'}</span><strong>{velocity.best}</strong></div>
          </div>
        </div>
        <div className="velocity-chart">
          <div className="velocity-chart-head">
            <h3>
              Completed per {velocity.unit === 'wk' ? 'week' : 'month'}
              {' '}<span className="approx">last {velocity.unit === 'wk' ? `${VELOCITY_WEEKS} weeks` : `${VELOCITY_MONTHS} months`} · current {velocity.unit === 'wk' ? 'week' : 'month'} is partial</span>
            </h3>
            <div className="velocity-toggle">
              <button type="button"
                onClick={() => setVelocityView('week')}
                className={'velocity-toggle-btn' + (velocityView === 'week' ? ' active' : '')}>
                Week
              </button>
              <button type="button"
                onClick={() => setVelocityView('month')}
                className={'velocity-toggle-btn' + (velocityView === 'month' ? ' active' : '')}>
                Month
              </button>
            </div>
          </div>
          <BarChart
            data={velocity.buckets.map(b => ({ name: b.label, count: b.count }))}
            xDataKey="name"
            aspectRatio={velocityView === 'week' ? '3.5 / 1' : '2.5 / 1'}
            margin={{ top: 12, right: 16, bottom: 28, left: 36 }}
          >
            <Grid />
            <Bar dataKey="count" fill="#3B6D11" />
            <ChartTooltip />
          </BarChart>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="chart-box">
          <h3>State distribution</h3>
          {stateDonutData.length === 0 ? (
            <div className="chart-empty">No items in window.</div>
          ) : (
            <div className="flex items-center justify-center" style={{ minHeight: 220 }}>
              <PieChart data={stateDonutData} innerRadius={70} padAngle={0.02} cornerRadius={3} className="max-w-[220px]">
                {stateDonutData.map((_, i) => <PieSlice key={i} index={i} hoverEffect="grow" />)}
                <PieCenter>
                  {() => (
                    <div className="text-center">
                      <div className="text-2xl font-medium">{stateDonutData.reduce((a, d) => a + d.value, 0)}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">items</div>
                    </div>
                  )}
                </PieCenter>
              </PieChart>
            </div>
          )}
        </div>
        <div className="chart-box">
          <h3>By priority</h3>
          <HBarList rows={priorityRows} />
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="chart-box">
          <h3>By work item type</h3>
          <HBarList rows={typeRows} empty="No items." />
        </div>
        <div className="chart-box">
          <h3>Created vs resolved <span className="approx">weekly</span></h3>
          <div className="flex items-center gap-4 mb-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#85B7EB' }} />Created</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: '#3B6D11' }} />Resolved</span>
          </div>
          {flowWeekly.length === 0 ? (
            <div className="chart-empty">Not enough data.</div>
          ) : (
            <AreaChart data={flowWeekly} xDataKey="date" aspectRatio="2 / 1"
              margin={{ top: 12, right: 20, bottom: 32, left: 36 }}>
              <Grid />
              <Area dataKey="created"  fill="#85B7EB" fillOpacity={0.35} strokeWidth={2} />
              <Area dataKey="resolved" fill="#3B6D11" fillOpacity={0.30} strokeWidth={2} />
              <XAxis numTicks={6} />
              <ChartTooltip />
            </AreaChart>
          )}
        </div>
      </section>
    </div>
  );
}
