/**
 * Explorer tab: portfolio cards + recursive hierarchy table with a grouping
 * builder. Items can be grouped by state_group / priority / type / assignee
 * at two levels (root and within-parent), driven by the builder UI.
 */
import { state } from './../state.js';
import { TYPE_COLORS, PRIORITY_INFO, FIELDS, GROUP_ORDER } from './../constants.js';
import {
  escapeHtml, prioCls, stateCls, fmtShortDate, projectPrefix, planeItemUrl,
} from './../utils.js';

const childrenOf = {};
const roots = [];
const explorerState = { generators: { root: [], child: [] }, expanded: new Set() };

/* ---------- Portfolio cards ---------- */
export function renderPortfolios() {
  const grid = document.getElementById('portfolio-grid');
  if (!grid) return;
  grid.innerHTML = (state.DATA.portfolios || []).map(p => {
    const bd = p.breakdown;
    const total = bd._total;
    const segs = [];
    if (bd.completed) segs.push(`<div class="pc-seg pc-seg-done"       style="width:${(100*bd.completed/total).toFixed(1)}%"></div>`);
    if (bd.started)   segs.push(`<div class="pc-seg pc-seg-inprogress" style="width:${(100*bd.started/total).toFixed(1)}%"></div>`);
    if (bd.unstarted) segs.push(`<div class="pc-seg pc-seg-unstarted"  style="width:${(100*bd.unstarted/total).toFixed(1)}%"></div>`);
    if (bd.backlog)   segs.push(`<div class="pc-seg pc-seg-backlog"    style="width:${(100*bd.backlog/total).toFixed(1)}%"></div>`);
    if (bd.cancelled) segs.push(`<div class="pc-seg pc-seg-cancelled"  style="width:${(100*bd.cancelled/total).toFixed(1)}%"></div>`);
    const dateStr = p.start_date ? `${fmtShortDate(p.start_date)} → ${fmtShortDate(p.target_date)}` : 'no dates';
    return `
      <div class="portfolio-card">
        <div class="pc-head">
          <h4>${escapeHtml(p.name)}</h4>
          <span class="badge ${prioCls(p.priority)}">${escapeHtml(p.priority)}</span>
        </div>
        <div class="pc-meta"><a href="${planeItemUrl(p.seq)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${projectPrefix()}-${p.seq}</a> · ${dateStr} · ${total} descendants</div>
        <div class="pc-progress-wrap">
          <div class="pc-progress-bar">${segs.join('')}</div>
          <div class="pc-tooltip">
            <div class="pc-tip-head"><strong>${bd._pct}% complete</strong><span class="pc-tip-sub">${bd._done} of ${bd._workable} workable</span></div>
            <div class="pc-tip-rows">
              <div class="pc-tip-row"><span class="pc-tip-dot" style="background:#3B6D11"></span><span class="pc-tip-label">Completed</span><span class="pc-tip-num">${bd.completed||0}</span></div>
              <div class="pc-tip-row"><span class="pc-tip-dot" style="background:#EF9F27"></span><span class="pc-tip-label">Started</span><span class="pc-tip-num">${bd.started||0}</span></div>
              <div class="pc-tip-row"><span class="pc-tip-dot" style="background:#85B7EB"></span><span class="pc-tip-label">Unstarted</span><span class="pc-tip-num">${bd.unstarted||0}</span></div>
              <div class="pc-tip-row"><span class="pc-tip-dot" style="background:#B4B2A9"></span><span class="pc-tip-label">Backlog</span><span class="pc-tip-num">${bd.backlog||0}</span></div>
              ${bd.cancelled ? `<div class="pc-tip-row"><span class="pc-tip-dot pc-tip-dot-cancelled"></span><span class="pc-tip-label">Cancelled (excluded)</span><span class="pc-tip-num">${bd.cancelled}</span></div>` : ''}
            </div>
            <div class="pc-tip-formula">% = Completed ÷ (Total − Cancelled)</div>
          </div>
        </div>
        <div class="pc-stats">
          <span><strong>${bd._done}</strong> done</span>
          <span><strong>${bd.started||0}</strong> active</span>
          <span><strong>${(bd.unstarted||0)+(bd.backlog||0)}</strong> waiting</span>
          ${p.assignee ? `<span style="color:#888780">·</span><span>${escapeHtml(p.assignee)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

/* ---------- Hierarchy rendering ---------- */

function groupLabel(field, key) {
  if (field === 'state_group') return state.DATA.state_group_info[key]?.label || key;
  if (field === 'priority')    return PRIORITY_INFO[key]?.label || key;
  return key;
}
function groupColor(field, key) {
  if (field === 'state_group') return state.DATA.state_group_info[key]?.color || '#888780';
  if (field === 'priority')    return PRIORITY_INFO[key]?.color || '#888780';
  if (field === 'type')        return TYPE_COLORS[key] || '#888780';
  if (field === 'assignee') {
    for (const uid in state.DATA.users) {
      if (state.DATA.users[uid] === key) return state.DATA.user_colors[uid] || '#888780';
    }
    return '#888780';
  }
  return '#1A1916';
}
function groupOrderForField(field, buckets) {
  if (GROUP_ORDER[field]) return GROUP_ORDER[field];
  return Object.keys(buckets).sort((a, b) => (buckets[b] || []).length - (buckets[a] || []).length);
}

function renderAssignee(name, color) {
  if (!name) return '<span style="color:#A09C92;font-size:11px">unassigned</span>';
  const initial = name.charAt(0).toUpperCase();
  return `<div class="assignee-cell"><span class="avatar" style="background:${color||'#888780'}">${initial}</span><span class="assignee-name">${escapeHtml(name)}</span></div>`;
}

function renderItemRow(item, depth) {
  const children = childrenOf[item.id] || [];
  const hasChildren = children.length > 0;
  const isExpanded = explorerState.expanded.has(item.id);
  const ti = { name: item.type, color: item.type_color || TYPE_COLORS[item.type] };
  const prio = PRIORITY_INFO[item.priority] || PRIORITY_INFO.none;
  const indent = '<span class="indent-guide"></span>'.repeat(depth);
  const chev = hasChildren
    ? `<button class="chevron" data-action="toggle-srow" data-id="${item.id}">${isExpanded ? '▼' : '▶'}</button>`
    : '<span class="chevron-spacer"></span>';
  let html = '<div class="srow">';
  html += `<div class="scell scell-summary">${indent}${chev}`;
  html += `<span class="type-icon" style="background:${ti.color}" title="${ti.name}"></span>`;
  html += `<a class="row-seq" href="${planeItemUrl(item.seq)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${projectPrefix()}-${item.seq}</a>`;
  html += `<span class="row-name">${escapeHtml(item.name)}</span>`;
  if (hasChildren) html += `<span class="group-count">${children.length}</span>`;
  html += '</div>';
  html += `<div class="scell">${renderAssignee(item.assignee, item.assignee_color)}</div>`;
  html += `<div class="scell"><span class="badge ${stateCls(item.state_group)}">${escapeHtml(item.state)}</span></div>`;
  html += `<div class="scell"><span class="badge ${prio.cls}">${prio.label}</span></div>`;
  html += `<div class="scell"><span style="color:${ti.color};font-size:11px">${ti.name}</span></div>`;
  html += '</div>';
  if (hasChildren && isExpanded) {
    html += applyGenerators(children, explorerState.generators.child, 0, depth + 1, '/' + item.id);
  }
  return html;
}

function renderGroupHeader(field, key, count, depth, path) {
  const isExpanded = explorerState.expanded.has(path);
  const label = groupLabel(field, key);
  const color = groupColor(field, key);
  const indent = '<span class="indent-guide"></span>'.repeat(depth);
  const chev = `<button class="chevron" data-action="toggle-srow" data-id="${path.replace(/'/g,"\\'")}">${isExpanded?'▼':'▶'}</button>`;
  let html = '<div class="srow srow-group"><div class="scell">';
  html += indent + chev;
  html += `<span class="group-dot" style="background:${color}"></span>`;
  html += `<span style="color:#6B6862;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-right:6px">${FIELDS[field].label}</span>`;
  html += `<strong>${escapeHtml(label)}</strong>`;
  html += `<span class="group-count">${count}</span>`;
  html += '</div></div>';
  return html;
}

function applyGenerators(items, generators, genIdx, depth, basePath) {
  if (genIdx >= generators.length) {
    let html = '';
    for (const it of items) html += renderItemRow(it, depth);
    return html;
  }
  const field = generators[genIdx];
  const buckets = {};
  for (const it of items) {
    const v = it[field] || 'none';
    (buckets[v] = buckets[v] || []).push(it);
  }
  let html = '';
  for (const key of groupOrderForField(field, buckets)) {
    if (!buckets[key]) continue;
    const childPath = basePath + '/' + field + ':' + key;
    html += renderGroupHeader(field, key, buckets[key].length, depth, childPath);
    if (explorerState.expanded.has(childPath)) {
      html += applyGenerators(buckets[key], generators, genIdx + 1, depth + 1, childPath);
    }
  }
  return html;
}

/* ---------- Builder toolbar ---------- */

function renderExplorerToolbar() {
  const totalRules = Object.values(explorerState.generators).reduce((a, b) => a + b.length, 0);
  document.getElementById('reset-btn').style.display = totalRules > 0 ? '' : 'none';
  const itemCount = state.DATA?.items?.length || 0;
  document.getElementById('groupby-meta').textContent =
    totalRules === 0
      ? `Pure hierarchy · ${itemCount} items`
      : `${totalRules} grouping rule${totalRules !== 1 ? 's' : ''}`;

  for (const level of Object.keys(explorerState.generators)) {
    const rules = explorerState.generators[level];
    const container = document.getElementById('rules-' + level);
    if (!container) continue;
    const row = container.closest('.builder-row');
    row.setAttribute('data-has-rules', rules.length > 0 ? 'true' : 'false');
    let inner = '';
    rules.forEach((field, idx) => {
      if (idx > 0) inner += '<span class="rule-arrow">→</span>';
      inner += `<span class="rule-pill"><span class="pill-order">${idx+1}</span><i class="ti ${FIELDS[field].icon}"></i>${FIELDS[field].label}<button class="pill-x" data-action="remove-rule" data-level="${level}" data-field="${field}">×</button></span>`;
    });
    const available = Object.keys(FIELDS).filter(f => !rules.includes(f));
    inner += '<div class="add-rule-wrap">';
    inner += `<button class="add-rule-btn" data-action="toggle-rule-menu" data-level="${level}"><i class="ti ti-plus"></i>${rules.length===0?'Group children by':'add'}</button>`;
    inner += `<div class="rule-menu" id="menu-${level}">`;
    if (available.length === 0) {
      inner += '<div class="rule-menu-empty">All fields used</div>';
    } else {
      inner += available.map(f => `<button class="rule-menu-item" data-action="add-rule" data-level="${level}" data-field="${f}"><i class="ti ${FIELDS[f].icon}"></i>${FIELDS[f].label}</button>`).join('');
    }
    inner += '</div></div>';
    container.innerHTML = inner;
  }
}

export function renderExplorer() {
  renderExplorerToolbar();
  const body = document.getElementById('structure-body');
  body.innerHTML = applyGenerators(roots, explorerState.generators.root, 0, 0, '');
  const itemCount = state.DATA?.items?.length || 0;
  document.getElementById('h-meta').textContent =
    `${itemCount} items · ${roots.length} roots · ${itemCount - roots.length} children`;
}

export function rebuildHierarchyState() {
  for (const k of Object.keys(childrenOf)) delete childrenOf[k];
  roots.length = 0;
  state.DATA.items.forEach(i => {
    if (i.parent) {
      (childrenOf[i.parent] = childrenOf[i.parent] || []).push(i);
    } else {
      roots.push(i);
    }
  });
  document.getElementById('lvl-root-count').textContent = roots.length + ' items';
  document.getElementById('lvl-child-count').textContent = (state.DATA.items.length - roots.length) + ' items';
}

export function defaultExpand() {
  (state.DATA.portfolios || []).forEach(p => explorerState.expanded.add(p.id));
}

/* ---------- Event handlers exposed to main.js ---------- */

export function toggleSrow(id) {
  if (explorerState.expanded.has(id)) explorerState.expanded.delete(id);
  else explorerState.expanded.add(id);
  renderExplorer();
}
export function addRule(level, field) {
  if (!explorerState.generators[level]) explorerState.generators[level] = [];
  if (explorerState.generators[level].includes(field)) return;
  explorerState.generators[level].push(field);
  if (level === 'root' && explorerState.generators.root.length === 1) {
    explorerState.expanded.clear();
    const f = explorerState.generators.root[0];
    const order = groupOrderForField(f, {});
    if (order && order.length) order.forEach(k => explorerState.expanded.add('/' + f + ':' + k));
  }
  document.querySelectorAll('.rule-menu').forEach(m => m.classList.remove('open'));
  renderExplorer();
}
export function removeRule(level, field) {
  explorerState.generators[level] = explorerState.generators[level].filter(f => f !== field);
  renderExplorer();
}
export function resetGenerators() {
  explorerState.generators = { root: [], child: [] };
  explorerState.expanded.clear();
  defaultExpand();
  renderExplorer();
}
export function toggleRuleMenu(e, level) {
  e.stopPropagation();
  const menu = document.getElementById('menu-' + level);
  const wasOpen = menu.classList.contains('open');
  document.querySelectorAll('.rule-menu').forEach(m => m.classList.remove('open'));
  if (!wasOpen) menu.classList.add('open');
}
export function toggleBuilder(e) {
  if (e && e.target.closest('button')) return;
  document.getElementById('builder').classList.toggle('collapsed');
}
