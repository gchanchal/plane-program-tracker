/**
 * App entry. Imports all modules, wires DOM event listeners, and runs
 * bootstrap → loadProjects → init(currentProject) → renderAll. Also exposes
 * a single `delegated click` handler so inline `data-action` attributes drive
 * behavior instead of inline onclick="" strings.
 */
import { state } from './state.js';
import { STORAGE_KEYS } from './constants.js';
import { escapeHtml } from './utils.js';
import { fetchProjects, fetchProjectData, fetchHistory, refreshProject } from './api.js';
import { applyTheme, cycleTheme, watchSystemPreference } from './theme.js';
import { resizeAllCharts } from './chart-base.js';
import { attachTabBar, restoreActiveTab } from './tabs.js';
import {
  renderProjectSelect, attachProjectPicker, setOnProjectSelect,
} from './projects.js';
import { renderRiskStrip, attachRiskStrip } from './risk-strip.js';
import { toggleFix, applyFix } from './action-fix.js';
import { renderPulseKPIs, makePulseCharts } from './views/pulse.js';
import {
  computeActions, renderActionBuckets, toggleBucket, jumpToBucket,
} from './views/action-center.js';
import { renderCapacity } from './views/capacity.js';
import { renderFlow }     from './views/flow.js';
import {
  renderPortfolios, renderExplorer, rebuildHierarchyState, defaultExpand,
  toggleSrow, addRule, removeRule, resetGenerators, toggleRuleMenu, toggleBuilder,
} from './views/explorer.js';

/* =========================================================================
 * Render orchestrator — called whenever DATA changes.
 * ========================================================================= */
function renderAll() {
  const cur = state.PROJECTS.find(p => p.id === state.CURRENT_PROJECT_ID) || {};
  document.title = (cur.identifier || cur.name || 'Plane') + ' · Program dashboard';
  const start = state.DATA.cutoff || '';
  document.getElementById('subhead').textContent =
    `${cur.name || 'Workspace data'} · last ${state.DATA._meta?.window_days || 183} days ` +
    `(${state.DATA.kpi.total} work items · ${start} → ${state.DATA.today})`;

  state.CURRENT_ACTIONS = computeActions();

  // Action Center tab badge.
  const total = Object.values(state.CURRENT_ACTIONS).reduce((a, b) => a + b.items.length, 0);
  const badge = document.getElementById('tab-badge-action');
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = '';
    badge.className = 'tab-badge ' + (total > 20 ? 'bad' : total > 5 ? 'warn' : '');
  } else {
    badge.style.display = 'none';
  }

  renderRiskStrip();
  renderPulseKPIs();
  makePulseCharts();
  renderActionBuckets();
  rebuildHierarchyState();
  defaultExpand();
  renderExplorer();
  renderPortfolios();
  renderCapacity();
  renderFlow();

  const meta = state.DATA._meta || {};
  const ws  = meta.workspace_slug || '?';
  const pid = (meta.project_id || '').slice(0, 8);
  document.getElementById('footer').innerHTML =
    `Local refresh server · workspace <strong>${ws}</strong> · project <strong>${pid}</strong> · ` +
    `${meta.item_count || 0} items · refreshed ${meta.last_refreshed_at || 'never'}`;
  updateLastUpdatedLabel();
}

function updateLastUpdatedLabel() {
  const ts = state.DATA?._meta?.last_refreshed_at;
  const el = document.getElementById('last-updated');
  if (!el) return;
  if (!ts) { el.textContent = ''; return; }
  el.textContent = 'updated ' + new Date(ts).toLocaleString();
}

/* =========================================================================
 * init: load data for the current project. Auto-trigger refresh if no cache.
 * ========================================================================= */
async function init(firstTime = true) {
  let data;
  try {
    data = await fetchProjectData(state.CURRENT_PROJECT_ID);
  } catch (e) {
    if (firstTime) {
      document.getElementById('subhead').textContent = 'No cached data for this project — fetching from Plane…';
      const pill = document.getElementById('live-pill');
      pill.textContent = 'Fetching';
      pill.style.background = '#FCE2C0';
      pill.style.color = '#7A4F00';
      await doRefresh();
    } else {
      alert('Failed to load: ' + e.message);
    }
    return;
  }
  const pill = document.getElementById('live-pill');
  pill.textContent = 'Live';
  pill.style.background = '';
  pill.style.color = '';
  state.DATA = data;
  state.HISTORY = await fetchHistory(state.CURRENT_PROJECT_ID);
  renderAll();
}

/* =========================================================================
 * Refresh — POST /api/refresh, then re-init.
 * ========================================================================= */
async function doRefresh() {
  if (!state.CURRENT_PROJECT_ID) { alert('Pick a project first.'); return; }
  const btn = document.getElementById('refresh-btn');
  const label = document.getElementById('refresh-label');
  btn.disabled = true; label.textContent = 'Refreshing…';
  try {
    await refreshProject(state.CURRENT_PROJECT_ID);
    await init(false);
    label.textContent = 'Refresh';
  } catch (e) {
    label.textContent = 'Refresh failed';
    alert('Refresh error: ' + e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => { label.textContent = 'Refresh'; }, 2500);
  }
}

/* =========================================================================
 * One delegated click handler for everything tagged with data-action="…".
 * Avoids per-element inline handlers and keeps event setup centralized.
 * ========================================================================= */
function setupDelegatedHandlers() {
  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    switch (action) {
      case 'toggle-bucket':   toggleBucket(el.dataset.key); break;
      case 'toggle-fix':      toggleFix(el.dataset.key, el.dataset.item); break;
      case 'save-fix':        applyFix(el.dataset.item, el, doRefresh); break;
      case 'toggle-srow':     toggleSrow(el.dataset.id); break;
      case 'add-rule':        addRule(el.dataset.level, el.dataset.field); break;
      case 'remove-rule':     removeRule(el.dataset.level, el.dataset.field); break;
      case 'toggle-rule-menu':toggleRuleMenu(e, el.dataset.level); break;
      case 'reset-rules':     resetGenerators(); break;
      case 'toggle-builder':  toggleBuilder(e); break;
      case 'do-refresh':      doRefresh(); break;
      case 'cycle-theme':     cycleTheme(); break;
      case 'print':           window.print(); break;
    }
  });
  // Close rule menus when clicking outside any add-rule wrap.
  document.addEventListener('click', e => {
    if (!e.target.closest('.add-rule-wrap')) {
      document.querySelectorAll('.rule-menu').forEach(m => m.classList.remove('open'));
    }
  });
}

/* =========================================================================
 * Window resize → debounced chart resize.
 * ========================================================================= */
function setupResize() {
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(resizeAllCharts, 120);
  });
}

/* =========================================================================
 * Load projects → pick the right one → init.
 * ========================================================================= */
async function loadProjects() {
  const body = await fetchProjects();
  state.PROJECTS = body.projects || [];
  const saved = localStorage.getItem(STORAGE_KEYS.project);
  if (saved && state.PROJECTS.some(p => p.id === saved)) state.CURRENT_PROJECT_ID = saved;
  else if (body.default_project_id && state.PROJECTS.some(p => p.id === body.default_project_id)) state.CURRENT_PROJECT_ID = body.default_project_id;
  else if (state.PROJECTS.length) state.CURRENT_PROJECT_ID = state.PROJECTS[0].id;
  renderProjectSelect();
}

/* =========================================================================
 * Bootstrap.
 * ========================================================================= */
(async function bootstrap() {
  setupDelegatedHandlers();
  setupResize();
  watchSystemPreference();
  attachTabBar();
  attachProjectPicker();
  attachRiskStrip(jumpToBucket);
  setOnProjectSelect(() => init(true));

  try {
    await loadProjects();
  } catch (e) {
    document.getElementById('subhead').innerHTML =
      `<span style="color:#A32D2D">Failed to load projects:</span> ${escapeHtml(e.message)}`;
    return;
  }
  if (!state.CURRENT_PROJECT_ID) {
    document.getElementById('subhead').textContent = 'No projects available in this workspace.';
    return;
  }

  applyTheme();
  restoreActiveTab();
  init(true);
})();
