/**
 * ECharts boilerplate: instance lifecycle + themed defaults for axes,
 * tooltips, and legends. All chart-rendering modules go through these.
 */
import { state } from './state.js';
import { effectiveTheme } from './theme.js';

/** Dispose a tracked chart instance by DOM id. */
export function destroyChart(id) {
  if (state.CHART_INSTANCES[id]) {
    state.CHART_INSTANCES[id].dispose();
    delete state.CHART_INSTANCES[id];
  }
}

/** Init (or re-init) an ECharts instance on a DOM node by id. Stores in state. */
export function mkChart(id, option) {
  destroyChart(id);
  const dom = document.getElementById(id);
  if (!dom) return null;
  const theme = effectiveTheme() === 'dark' ? 'dark' : null;
  const c = echarts.init(dom, theme, { renderer: 'canvas' });
  c.setOption(option);
  state.CHART_INSTANCES[id] = c;
  return c;
}

export function chartBg()   { return effectiveTheme() === 'dark' ? '#1E1D1A' : '#FFFFFF'; }
export function chartGrid() { return effectiveTheme() === 'dark' ? '#2A2924' : '#F1EFE8'; }
export function chartMuted(){ return effectiveTheme() === 'dark' ? '#A09C92' : '#6B6862'; }
export function chartText() { return effectiveTheme() === 'dark' ? '#F0EEE8' : '#1A1916'; }

/** Themed axis defaults; merge with chart-specific overrides. */
export function baseAxis(extra) {
  const dark = effectiveTheme() === 'dark';
  return Object.assign({
    axisLine:  { lineStyle: { color: dark ? '#3A3933' : '#D6D3C8' } },
    axisTick:  { lineStyle: { color: dark ? '#3A3933' : '#D6D3C8' } },
    axisLabel: { color: chartMuted(), fontSize: 10 },
    splitLine: { lineStyle: { color: chartGrid() } },
  }, extra || {});
}

/** Themed tooltip styling (inverted bg vs. page). */
export function baseTooltip() {
  const dark = effectiveTheme() === 'dark';
  return {
    backgroundColor: dark ? '#F0EEE8' : '#1A1916',
    borderColor:     dark ? '#F0EEE8' : '#1A1916',
    textStyle:       { color: dark ? '#1A1916' : '#FAFAF7', fontSize: 11 },
    extraCssText:    'box-shadow: 0 6px 16px rgba(0,0,0,0.12); border-radius: 6px;',
  };
}

/** Themed bottom-centered legend. */
export function baseLegend() {
  return {
    bottom: 0, left: 'center',
    textStyle: { color: chartMuted(), fontSize: 11 },
    itemWidth: 12, itemHeight: 8,
  };
}

/** Resize every tracked chart instance. Called from window 'resize' (debounced). */
export function resizeAllCharts() {
  Object.values(state.CHART_INSTANCES).forEach(c => { try { c.resize(); } catch (_) {} });
}
