import { useMemo } from 'react';
import { useDashboard } from '@/lib/dashboard-context';
import { TYPE_COLORS } from '@/lib/constants';
import { daysBetween, isoWeekStart } from '@/lib/format';
import type { StateGroup } from '@/lib/types';
import { AreaChart } from '@/components/charts/area-chart';
import { Area } from '@/components/charts/area';
import { BarChart } from '@/components/charts/bar-chart';
import { Bar } from '@/components/charts/bar';
import { Grid } from '@/components/charts/grid';
import { XAxis } from '@/components/charts/x-axis';
import { ChartTooltip } from '@/components/charts/tooltip/chart-tooltip';
import { HBarList } from '@/components/HBarList';

const G_ORDER: StateGroup[] = ['completed', 'started', 'unstarted', 'backlog', 'cancelled'];

export function FlowView() {
  const { data, history } = useDashboard();

  const series = useMemo(() => {
    if (!data) return [];
    const created = new Map<string, number>();
    const completed = new Map<string, number>();
    for (const i of data.items) {
      if (i.created_at) {
        const w = isoWeekStart(i.created_at);
        created.set(w, (created.get(w) || 0) + 1);
      }
      if (i.state_group === 'completed' && i.updated_at) {
        const w = isoWeekStart(i.updated_at);
        completed.set(w, (completed.get(w) || 0) + 1);
      }
    }
    const allWeeks = Array.from(new Set([...created.keys(), ...completed.keys()])).sort();
    return allWeeks.map(w => ({
      name: w.slice(5),    // Bar chart uses categorical x; short label
      date: new Date(w),   // Area chart needs real Date for scaleTime
      week: w,
      created: created.get(w) || 0,
      completed: completed.get(w) || 0,
    }));
  }, [data]);

  const netSeries = useMemo(() => {
    let net = 0;
    return series.map(s => {
      net += s.created - s.completed;
      return { date: s.date, net };
    });
  }, [series]);

  const cycleRows = useMemo(() => {
    if (!data) return [] as Array<{ label: string; value: number; color: string; sub?: string }>;
    const byType: Record<string, number[]> = {};
    for (const i of data.items) {
      if (i.state_group !== 'completed') continue;
      const d = daysBetween(i.created_at, i.updated_at);
      if (d === null || d < 0) continue;
      (byType[i.type] = byType[i.type] || []).push(d);
    }
    return Object.entries(byType)
      .map(([t, arr]) => {
        const sorted = arr.slice().sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
        return { label: t, value: median, color: TYPE_COLORS[t] || '#888780', sub: `(n=${arr.length})` };
      })
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const cfdData = useMemo(() => {
    if (!data) return [] as Array<Record<string, number | Date>>;
    return history
      .filter(h => h.ts)
      .map(h => {
        const row: Record<string, number | Date> = { date: new Date(h.ts) };
        for (const g of G_ORDER) row[g] = h.group_counts?.[g] || 0;
        return row;
      });
  }, [history, data]);

  if (!data) return <div className="text-sm text-muted-foreground p-4">No data.</div>;

  // Headline metrics
  const lastWeek = series[series.length - 1];
  const last4 = series.slice(-4);
  const throughput4w = last4.length ? Math.round(last4.reduce((a, s) => a + s.completed, 0) / last4.length) : 0;
  const cycleAll: number[] = [];
  for (const i of data.items) {
    if (i.state_group !== 'completed') continue;
    const dd = daysBetween(i.created_at, i.updated_at);
    if (dd !== null && dd >= 0) cycleAll.push(dd);
  }
  cycleAll.sort((a, b) => a - b);
  const medianCycle = cycleAll.length ? cycleAll[Math.floor(cycleAll.length / 2)] : 0;
  const weekNet = lastWeek ? lastWeek.created - lastWeek.completed : 0;

  return (
    <div className="space-y-3">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="kpi kpi-good">
          <div className="kpi-label"><span className="kpi-dot" />Throughput</div>
          <div className="kpi-value">{throughput4w}</div>
          <div className="kpi-sub">avg completed / wk (last 4)</div>
        </div>
        <div className="kpi kpi-violet">
          <div className="kpi-label"><span className="kpi-dot" />Cycle time (median)</div>
          <div className="kpi-value">{medianCycle}<span className="text-base text-muted-foreground font-normal ml-1">d</span></div>
          <div className="kpi-sub">created → completed, all in window</div>
        </div>
        <div className="kpi kpi-cool">
          <div className="kpi-label"><span className="kpi-dot" />Created (this wk)</div>
          <div className="kpi-value">{lastWeek?.created ?? 0}</div>
          <div className="kpi-sub"><strong>{lastWeek?.completed ?? 0}</strong> completed</div>
        </div>
        <div className={'kpi ' + (weekNet > 0 ? 'kpi-bad' : weekNet < 0 ? 'kpi-good' : 'kpi-cool')}>
          <div className="kpi-label"><span className="kpi-dot" />Net WIP (this wk)</div>
          <div className="kpi-value">{weekNet > 0 ? '+' : ''}{weekNet}</div>
          <div className="kpi-sub">
            {weekNet > 0 ? <span className="neg">backlog growing</span> : weekNet < 0 ? <span className="pos">backlog shrinking</span> : 'flat'}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="chart-box">
          <h3>Created vs completed (weekly)</h3>
          {series.length === 0 ? <div className="chart-empty">No history yet.</div> : (
            <BarChart data={series} xDataKey="name" aspectRatio="2 / 1"
              margin={{ top: 12, right: 20, bottom: 36, left: 40 }}>
              <Grid />
              <Bar dataKey="created"   fill="#85B7EB" />
              <Bar dataKey="completed" fill="#3B6D11" />
              <ChartTooltip />
            </BarChart>
          )}
        </div>
        <div className="chart-box">
          <h3>Net WIP change (cumulative)</h3>
          {netSeries.length === 0 ? <div className="chart-empty">No history yet.</div> : (
            <AreaChart data={netSeries} xDataKey="date" aspectRatio="2 / 1"
              margin={{ top: 12, right: 20, bottom: 32, left: 40 }}>
              <Grid />
              <Area dataKey="net" fill="#A32D2D" fillOpacity={0.3} />
              <XAxis numTicks={6} />
              <ChartTooltip />
            </AreaChart>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="chart-box">
          <h3>Cycle time by type <span className="approx">created → updated, completed only</span></h3>
          <HBarList rows={cycleRows} valueSuffix="d" empty="No completed items yet." />
        </div>
        <div className="chart-box">
          <h3>State mix over refreshes <span className="approx">snapshot history</span></h3>
          {history.length < 2 ? (
            <div className="chart-empty">Need at least 2 refreshes to show trend.<br />Refresh this project a few more times to populate the CFD.</div>
          ) : (
            <AreaChart data={cfdData} xDataKey="date" aspectRatio="2 / 1"
              margin={{ top: 12, right: 20, bottom: 36, left: 40 }}>
              <Grid />
              {G_ORDER.map(g => (
                <Area key={g} dataKey={g} fill={data.state_group_info[g].color} fillOpacity={0.45} />
              ))}
              <XAxis numTicks={5} />
              <ChartTooltip />
            </AreaChart>
          )}
        </div>
      </section>
    </div>
  );
}
