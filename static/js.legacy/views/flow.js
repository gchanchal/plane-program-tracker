/**
 * Flow tab: 4 ECharts (created vs completed weekly, cumulative net WIP,
 * median cycle time by type, CFD from history snapshots).
 */
import { state } from './../state.js';
import { TYPE_COLORS } from './../constants.js';
import { isoWeekStart, daysBetween } from './../utils.js';
import {
  mkChart, destroyChart, baseAxis, baseTooltip, baseLegend, chartMuted,
} from './../chart-base.js';
import { effectiveTheme } from './../theme.js';

const G_ORDER = ['completed', 'started', 'unstarted', 'backlog', 'cancelled'];

/** Created / completed counts grouped by ISO-week-start across DATA.items. */
function weeklySeries() {
  const created = new Map(), completed = new Map();
  for (const i of state.DATA.items) {
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
    week: w,
    created:   created.get(w)   || 0,
    completed: completed.get(w) || 0,
  }));
}

function renderThroughput(series, labels) {
  mkChart('ch-flow-throughput', {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip() },
    legend: baseLegend(),
    grid: { left: 40, right: 20, top: 12, bottom: 44 },
    xAxis: baseAxis({
      type: 'category', data: labels,
      axisLabel: { fontSize: 9, color: chartMuted(), interval: 'auto' },
    }),
    yAxis: baseAxis({ type: 'value' }),
    series: [
      { name: 'Created',   type: 'bar', data: series.map(s => s.created),   itemStyle: { color: '#85B7EB', borderRadius: [2, 2, 0, 0] }, emphasis: { focus: 'series' } },
      { name: 'Completed', type: 'bar', data: series.map(s => s.completed), itemStyle: { color: '#3B6D11', borderRadius: [2, 2, 0, 0] }, emphasis: { focus: 'series' } },
    ],
  });
}

function renderNetWip(series, labels) {
  let net = 0;
  const netSeries = series.map(s => { net += (s.created - s.completed); return net; });
  const dark = effectiveTheme() === 'dark';
  mkChart('ch-flow-net', {
    tooltip: {
      trigger: 'axis', ...baseTooltip(),
      formatter: p => `${p[0].name}<br/>Net WIP change: <strong>${p[0].value > 0 ? '+' : ''}${p[0].value}</strong>`,
    },
    grid: { left: 40, right: 20, top: 12, bottom: 28 },
    xAxis: baseAxis({ type: 'category', data: labels, boundaryGap: false, axisLabel: { fontSize: 9, color: chartMuted() } }),
    yAxis: baseAxis({ type: 'value' }),
    series: [{
      type: 'line', smooth: 0.3, showSymbol: false,
      data: netSeries,
      lineStyle: { color: '#A32D2D', width: 2 },
      itemStyle: { color: '#A32D2D' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(163,45,45,0.28)' },
          { offset: 1, color: 'rgba(163,45,45,0)'   },
        ]),
      },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: dark ? '#6B6862' : '#B8B4A8', type: 'dashed' },
        data: [{ yAxis: 0 }],
      },
    }],
  });
}

function renderCycleTime() {
  const byType = {};
  for (const i of state.DATA.items) {
    if (i.state_group !== 'completed') continue;
    const d = daysBetween(i.created_at, i.updated_at);
    if (d === null || d < 0) continue;
    (byType[i.type] = byType[i.type] || []).push(d);
  }
  const labels = Object.keys(byType).sort();
  const medians = labels.map(t => {
    const arr = byType[t].slice().sort((a, b) => a - b);
    return arr.length ? arr[Math.floor(arr.length / 2)] : 0;
  });
  const counts = labels.map(t => byType[t].length);
  mkChart('ch-flow-cycle', {
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip(),
      formatter: p => `${p[0].name}<br/>median <strong>${p[0].value}</strong> days`,
    },
    grid: { left: 100, right: 30, top: 12, bottom: 30 },
    xAxis: baseAxis({ type: 'value', name: 'days', nameTextStyle: { fontSize: 10, color: chartMuted() } }),
    yAxis: baseAxis({
      type: 'category',
      data: labels.map((t, i) => `${t} (n=${counts[i]})`),
      splitLine: { show: false }, inverse: true,
    }),
    series: [{
      type: 'bar',
      data: medians.map((m, i) => ({ value: m, itemStyle: { color: TYPE_COLORS[labels[i]] || '#888780', borderRadius: [0, 3, 3, 0] } })),
      label: { show: true, position: 'right', fontSize: 10, formatter: '{c}d', color: chartMuted() },
    }],
  });
}

function renderCFD() {
  destroyChart('ch-flow-cfd');
  if (state.HISTORY.length < 2) {
    const ctx = document.getElementById('ch-flow-cfd');
    if (ctx) {
      ctx.parentElement.innerHTML =
        '<div id="ch-flow-cfd" style="display:flex;height:100%;align-items:center;justify-content:center;color:#888780;font-size:12px;text-align:center;padding:0 20px">' +
        'Need at least 2 refreshes to show trend.<br>Refresh this project a few more times to populate the CFD.</div>';
    }
    return;
  }
  const labels = state.HISTORY.map(h => (h.ts || '').slice(5, 16).replace('T', ' '));
  mkChart('ch-flow-cfd', {
    tooltip: { trigger: 'axis', ...baseTooltip() },
    legend: baseLegend(),
    grid: { left: 40, right: 20, top: 12, bottom: 44 },
    xAxis: baseAxis({ type: 'category', data: labels, boundaryGap: false, axisLabel: { fontSize: 9, color: chartMuted() } }),
    yAxis: baseAxis({ type: 'value' }),
    series: G_ORDER.map(g => ({
      name: state.DATA.state_group_info[g].label,
      type: 'line', stack: 'cfd',
      smooth: 0.2, showSymbol: false,
      data: state.HISTORY.map(h => (h.group_counts || {})[g] || 0),
      lineStyle: { width: 1 },
      itemStyle: { color: state.DATA.state_group_info[g].color },
      areaStyle: { color: state.DATA.state_group_info[g].color, opacity: 0.6 },
      emphasis: { focus: 'series' },
    })),
  });
}

export function renderFlow() {
  if (!state.DATA) return;
  const series = weeklySeries();
  const labels = series.map(s => s.week.slice(5));
  renderThroughput(series, labels);
  renderNetWip(series, labels);
  renderCycleTime();
  renderCFD();
}
