/**
 * Capacity tab: per-assignee table with mix-progress bar + 2 ECharts
 * (stacked active load colored by priority, completed-30d horizontal bar).
 */
import { state } from './../state.js';
import { THRESHOLDS, PRIORITY_INFO } from './../constants.js';
import { escapeHtml, thirtyDaysAgoIso } from './../utils.js';
import { mkChart, baseAxis, baseTooltip, baseLegend, chartMuted } from './../chart-base.js';

const P_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];

/** Group items by assignee, computing backlog/unstarted/started/done30 counts. */
export function computeCapacity() {
  const byKey = new Map();
  const since30 = thirtyDaysAgoIso();
  for (const i of state.DATA.items) {
    const key = i.assignee_id || (i.assignee ? 'name:' + i.assignee : '__none__');
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: key,
        name: i.assignee || 'Unassigned',
        color: i.assignee_color || '#888780',
        backlog: 0, unstarted: 0, started: 0, done30: 0,
        by_priority: { urgent: 0, high: 0, medium: 0, low: 0, none: 0 },
        active_items: [],
      });
    }
    const a = byKey.get(key);
    if      (i.state_group === 'backlog')   a.backlog++;
    else if (i.state_group === 'unstarted') a.unstarted++;
    else if (i.state_group === 'started') {
      a.started++;
      a.by_priority[i.priority] = (a.by_priority[i.priority] || 0) + 1;
      a.active_items.push(i);
    }
    if (i.state_group === 'completed' && (i.updated_at || '').slice(0, 10) >= since30) {
      a.done30++;
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => (b.started - a.started) || (b.done30 - a.done30));
}

function workloadFlag(started) {
  if (started >= THRESHOLDS.wipOverload) return { cls: 'over', label: 'overload' };
  if (started >= THRESHOLDS.wipHigh)     return { cls: 'high', label: 'heavy'    };
  if (started > 0)                        return { cls: 'ok',   label: 'ok'       };
  return                                          { cls: 'idle', label: 'idle'     };
}

function progressBar(r) {
  const total = r.backlog + r.unstarted + r.started + r.done30;
  if (total === 0) {
    return `<div class="cap-bar-wrap"><div class="cap-bar"></div><div class="cap-bar-label"><span class="muted">no items in window</span></div></div>`;
  }
  const pct = (n) => (100 * n / total).toFixed(1);
  const segs = [
    r.done30    ? `<div class="cap-bar-seg done"      style="width:${pct(r.done30)}%"    title="Done (30d): ${r.done30}"></div>` : '',
    r.started   ? `<div class="cap-bar-seg active"    style="width:${pct(r.started)}%"   title="Active WIP: ${r.started}"></div>` : '',
    r.unstarted ? `<div class="cap-bar-seg unstarted" style="width:${pct(r.unstarted)}%" title="Unstarted: ${r.unstarted}"></div>` : '',
    r.backlog   ? `<div class="cap-bar-seg backlog"   style="width:${pct(r.backlog)}%"   title="Backlog: ${r.backlog}"></div>`   : '',
  ].join('');
  const donePct = Math.round(100 * r.done30 / total);
  return `<div class="cap-bar-wrap">
    <div class="cap-bar">${segs}</div>
    <div class="cap-bar-label">
      <span class="pct">${donePct}% done</span>
      <span class="muted">${total} items</span>
    </div>
  </div>`;
}

function renderTable(rows) {
  const host = document.getElementById('cap-table');
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<div class="action-empty">No assignees in this window.</div>';
    return;
  }
  let html = `
    <div class="cap-row cap-head">
      <div>Assignee</div>
      <div>Progress</div>
      <div style="text-align:right">Backlog</div>
      <div style="text-align:right">Unstarted</div>
      <div style="text-align:right">Active WIP</div>
      <div style="text-align:right">Done (30d)</div>
      <div style="text-align:center">Status</div>
    </div>`;
  for (const r of rows) {
    const flag = workloadFlag(r.started);
    const initial = (r.name || '?').charAt(0).toUpperCase();
    html += `
      <div class="cap-row">
        <div class="cap-name">
          <span class="avatar" style="background:${r.color}">${initial}</span>
          <span class="name">${escapeHtml(r.name)}</span>
        </div>
        ${progressBar(r)}
        <div class="cap-num ${r.backlog ? '' : 'muted'}">${r.backlog}</div>
        <div class="cap-num ${r.unstarted ? '' : 'muted'}">${r.unstarted}</div>
        <div class="cap-num"><strong>${r.started}</strong></div>
        <div class="cap-num ${r.done30 ? '' : 'muted'}">${r.done30}</div>
        <div><span class="cap-flag ${flag.cls}">${flag.label}</span></div>
      </div>`;
  }
  host.innerHTML = html;
}

function renderActiveLoadChart(top, labels) {
  mkChart('ch-cap-load', {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip() },
    legend: baseLegend(),
    grid: { left: 110, right: 20, top: 10, bottom: 44, containLabel: false },
    xAxis: baseAxis({ type: 'value' }),
    yAxis: baseAxis({ type: 'category', data: labels, splitLine: { show: false }, inverse: true }),
    series: P_ORDER.map(p => ({
      name: PRIORITY_INFO[p].label,
      type: 'bar', stack: 'wip',
      data: top.map(r => r.by_priority[p] || 0),
      itemStyle: { color: PRIORITY_INFO[p].color },
      emphasis: { focus: 'series' },
    })),
  });
}

function renderDoneChart(top, labels) {
  mkChart('ch-cap-done', {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...baseTooltip() },
    grid: { left: 110, right: 30, top: 10, bottom: 24, containLabel: false },
    xAxis: baseAxis({ type: 'value' }),
    yAxis: baseAxis({ type: 'category', data: labels, splitLine: { show: false }, inverse: true }),
    series: [{
      type: 'bar',
      data: top.map(r => ({ value: r.done30, itemStyle: { color: r.color || '#888780', borderRadius: [0, 3, 3, 0] } })),
      label: { show: true, position: 'right', fontSize: 10, color: chartMuted() },
    }],
  });
}

export function renderCapacity() {
  if (!state.DATA) return;
  const rows = computeCapacity();
  renderTable(rows);

  // Charts: top 25 by load + recent throughput, so the chart stays scannable.
  const top = rows.slice()
    .sort((a, b) => (b.started + b.done30) - (a.started + a.done30))
    .slice(0, 25);
  const labels = top.map(r => r.name);
  renderActiveLoadChart(top, labels);
  renderDoneChart(top, labels);
}
