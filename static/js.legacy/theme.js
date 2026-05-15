/**
 * Theme cycle (light → dark → system) and chart re-render on theme change.
 * The data-theme attribute is set early by an inline script in dashboard.html
 * to avoid FOUC; this module handles the runtime toggle and live system
 * preference tracking.
 */
import { state } from './state.js';
import { STORAGE_KEYS } from './constants.js';
import { makePulseCharts }  from './views/pulse.js';
import { renderCapacity }   from './views/capacity.js';
import { renderFlow }       from './views/flow.js';

const THEME_ICONS = {
  light:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="3" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21"/><line x1="3" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="7.05" y2="7.05"/><line x1="16.95" y1="16.95" x2="18.4" y2="18.4"/><line x1="5.6" y1="18.4" x2="7.05" y2="16.95"/><line x1="16.95" y1="7.05" x2="18.4" y2="5.6"/></svg>',
  dark:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  system: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1"/><line x1="2" y1="20" x2="22" y2="20"/></svg>',
};
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

/** Returns 'light' or 'dark' (system resolves via prefers-color-scheme). */
export function effectiveTheme() {
  const pref = localStorage.getItem(STORAGE_KEYS.theme) || 'system';
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

/** Apply the current theme to the DOM and update the toggle button. */
export function applyTheme() {
  const pref = localStorage.getItem(STORAGE_KEYS.theme) || 'system';
  const eff = effectiveTheme();
  document.documentElement.setAttribute('data-theme', eff);
  document.documentElement.setAttribute('data-theme-pref', pref);

  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.innerHTML = THEME_ICONS[pref] || THEME_ICONS.system;
    btn.title = `Theme: ${THEME_LABELS[pref]} (click to change)`;
  }

  // Re-render charts so theme-aware colors take effect.
  if (state.DATA) {
    makePulseCharts();
    renderCapacity();
    renderFlow();
  }
}

/** Cycle: light → dark → system → light. */
export function cycleTheme() {
  const cur = localStorage.getItem(STORAGE_KEYS.theme) || 'system';
  const next = cur === 'light' ? 'dark' : cur === 'dark' ? 'system' : 'light';
  localStorage.setItem(STORAGE_KEYS.theme, next);
  applyTheme();
}

/** Re-apply when OS appearance changes (only matters in 'system' mode). */
export function watchSystemPreference() {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem(STORAGE_KEYS.theme) || 'system') === 'system') applyTheme();
  });
}
