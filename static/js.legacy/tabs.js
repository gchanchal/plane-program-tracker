/**
 * Tab navigation. Persists the active tab to localStorage so reloads return
 * to where you left off. Re-renders the relevant view when switching, which
 * lets ECharts measure dimensions for previously-hidden panels.
 */
import { STORAGE_KEYS } from './constants.js';
import { makePulseCharts } from './views/pulse.js';
import { renderCapacity }  from './views/capacity.js';
import { renderFlow }      from './views/flow.js';

export function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === name));
  localStorage.setItem(STORAGE_KEYS.tab, name);
  // ECharts can't size in display:none. Re-render on switch.
  if      (name === 'capacity') renderCapacity();
  else if (name === 'flow')     renderFlow();
  else if (name === 'pulse')    makePulseCharts();
}

export function attachTabBar() {
  const bar = document.getElementById('tabs');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) switchTab(t.dataset.tab);
  });
}

/** Restore active tab from localStorage on load. Returns the restored name. */
export function restoreActiveTab() {
  const saved = localStorage.getItem(STORAGE_KEYS.tab);
  if (!saved) return null;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === saved));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === saved));
  return saved;
}
