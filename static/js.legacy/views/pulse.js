/**
 * Pulse tab: 4 KPI cards + 4 ECharts (state donut, priority bar, type bar,
 * weekly creation line). Reads state.DATA and state.CURRENT_ACTIONS.
 */
import { state } from './../state.js';
import { TYPE_COLORS, PRIORITY_INFO } from './../constants.js';
import { thirtyDaysAgoIso } from './../utils.js';
import { mkChart, baseAxis, baseTooltip, baseLegend, chartMuted } from './../chart-base.js';
import { effectiveTheme } from './../theme.js';

const G_ORDER = ['completed', 'started', 'unstarted', 'backlog', 'cancelled'];
const P_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];

/* ---------- KPI numbers ---------- */
export function renderPulseKPIs() {
  if (!state.DATA) return;
  const items = state.DATA.items;
  const wip       = items.filter(i => i.state_group === 'started').length;
  const unstarted = items.filter(i => i.state_group === 'unstarted').length;
  const since = thirtyDaysAgoIso();
  const created30 = items.filter(i => (i.created_at || '').slice(0, 10) >= since).length;
  const done30    = items.filter(i => i.state_group === 'completed' && (i.updated_at || '').slice(0, 10) >= since).length;
  const net       = created30 - done30;
  const risk = (state.CURRENT_ACTIONS?.past_due.items.length || 0)
             + (state.CURRENT_ACTIONS?.aging_wip.items.length || 0);

  document.getElementById('kpi-wip').textContent = wip;
  document.getElementById('kpi-wip-sub').innerHTML = `<strong>${unstarted}</strong> waiting to start`;
  document.getElementById('kpi-done30').textContent = done30;
  document.getElementById('kpi-done30-sub').textContent = 'in the last 30 days';

  document.getElementById('kpi-net').innerHTML = (net > 0 ? '+' : '') + net;
  const netSub = document.getElementById('kpi-net-sub');
  if (net > 0)      netSub.innerHTML = `<span class="neg">backlog growing</span> · <strong>${created30}</strong> created · <strong>${done30}</strong> done`;
  else if (net < 0) netSub.innerHTML = `<span class="pos">backlog shrinking</span> · <strong>${created30}</strong> created · <strong>${done30}</strong> done`;
  else              netSub.innerHTML = `<strong>${created30}</strong> created · <strong>${done30}</strong> done`;

  document.getElementById('kpi-risk').textContent = risk;
  document.getElementById('kpi-risk-sub').innerHTML =
    `<strong>${state.CURRENT_ACTIONS?.past_due.items.length || 0}</strong> past due · ` +
    `<strong>${state.CURRENT_ACTIONS?.aging_wip.items.length || 0}</strong> aging`;
}

/* ---------- Charts ---------- */
export function makePulseCharts() {
  if (!state.DATA) return;
  renderStateDonut();
  renderPriorityBar();
  renderTypeBar();
  renderWeeklyLine();
}

function renderStateDonut() {
  const gc = state.DATA.group_counts;
  const data = G_ORDER
    .map(g => ({
      value: gc[g] || 0,
      name: state.DATA.state_group_info[g].label,
      itemStyle: { color: state.DATA.state_group_info[g].color },
    }))
    .filter(d => d.value > 0);
  mkChart('ch-status', {
    tooltip: { trigger: 'item', formatter: '{b}<br/><strong>{c}</strong> ({d}%)', ...baseTooltip() },
    legend: baseLegend(),
    series: [{
      name: 'State', type: 'pie',
      radius: ['55%', '78%'], center: ['50%', '46%'],
      avoidLabelOverlap: false,
      label: { show: false }, labelLine: { show: false },
      emphasis: {
        label: {
          show: true, fontSize: 14, fontWeight: 500,
          color: effectiveTheme() === 'dark' ? '#F0EEE8' : '#1A1916',
        },
      },
      data,
    }],
  });
}

function renderPriorityBar() {
  mkChart('ch-priority', {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip() },
    grid: { left: 70, right: 24, top: 10, bottom: 24, containLabel: false },
    xAxis: baseAxis({ type: 'value' }),
    yAxis: baseAxis({ type: 'category', data: P_ORDER.map(p => PRIORITY_INFO[p].label), splitLine: { show: false } }),
    series: [{
      type: 'bar', barCategoryGap: '36%',
      data: P_ORDER.map(p => ({
        value: state.DATA.priority_counts[p] || 0,
        itemStyle: { color: PRIORITY_INFO[p].color, borderRadius: [0, 3, 3, 0] },
      })),
      label: { show: true, position: 'right', fontSize: 10, color: chartMuted() },
    }],
  });
}

function renderTypeBar() {
  const types = Object.entries(state.DATA.type_counts).sort((a, b) => b[1] - a[1]);
  mkChart('ch-type', {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip() },
    grid: { left: 80, right: 24, top: 10, bottom: 24, containLabel: false },
    xAxis: baseAxis({ type: 'value' }),
    yAxis: baseAxis({ type: 'category', data: types.map(t => t[0]), splitLine: { show: false } }),
    series: [{
      type: 'bar', barCategoryGap: '36%',
      data: types.map(t => ({
        value: t[1],
        itemStyle: { color: TYPE_COLORS[t[0]] || '#888780', borderRadius: [0, 3, 3, 0] },
      })),
      label: { show: true, position: 'right', fontSize: 10, color: chartMuted() },
    }],
  });
}

function renderWeeklyLine() {
  const weeks = state.DATA.weeks;
  const lineColor = effectiveTheme() === 'dark' ? '#F0EEE8' : '#1A1916';
  mkChart('ch-weekly', {
    tooltip: { trigger: 'axis', ...baseTooltip() },
    grid: { left: 40, right: 20, top: 12, bottom: 28 },
    xAxis: baseAxis({
      type: 'category',
      data: weeks.map(w => w.week.slice(5)),
      boundaryGap: false,
      axisLabel: { fontSize: 9, color: chartMuted() },
    }),
    yAxis: baseAxis({ type: 'value' }),
    series: [{
      type: 'line', smooth: 0.3, showSymbol: false,
      data: weeks.map(w => w.count),
      lineStyle: { color: lineColor, width: 2 },
      itemStyle: { color: lineColor },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: lineColor + '33' },
          { offset: 1, color: lineColor + '00' },
        ]),
      },
    }],
  });
}
