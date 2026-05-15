/**
 * Searchable project picker in the breadcrumb. Driven by state.PROJECTS;
 * selection writes to state.CURRENT_PROJECT_ID + localStorage and triggers
 * a re-init (loaded by main.js to break the import cycle).
 */
import { state } from './state.js';
import { STORAGE_KEYS } from './constants.js';
import { escapeHtml, currentProject } from './utils.js';

let onSelectCb = () => {};

export function setOnProjectSelect(fn) { onSelectCb = fn; }

export function renderProjectSelect() {
  const trigger = document.getElementById('project-trigger');
  const label = document.getElementById('project-trigger-label');
  if (!trigger || !label) return;
  if (!state.PROJECTS.length) {
    label.textContent = 'No projects';
    trigger.disabled = true;
    return;
  }
  trigger.disabled = false;
  const cur = currentProject();
  label.textContent = cur.identifier ? `${cur.identifier} · ${cur.name}` : (cur.name || 'Select project…');
  renderProjectList('');
}

export function renderProjectList(query) {
  const list = document.getElementById('project-list');
  if (!list) return;
  const q = (query || '').toLowerCase().trim();
  const filtered = q
    ? state.PROJECTS.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.identifier || '').toLowerCase().includes(q))
    : state.PROJECTS;
  if (!filtered.length) {
    list.innerHTML = '<div class="project-empty">No matches</div>';
    return;
  }
  list.innerHTML = filtered.map(p => `
    <div class="project-item ${p.id === state.CURRENT_PROJECT_ID ? 'selected' : ''}" data-id="${p.id}">
      ${p.identifier ? `<span class="ident">${escapeHtml(p.identifier)}</span>` : ''}
      <span class="name">${escapeHtml(p.name || p.id)}</span>
      ${p.id === state.CURRENT_PROJECT_ID ? '<i class="ti ti-check check"></i>' : ''}
    </div>`).join('');
}

export function attachProjectPicker() {
  const picker  = document.getElementById('project-picker');
  const trigger = document.getElementById('project-trigger');
  const search  = document.getElementById('project-search');
  const list    = document.getElementById('project-list');
  if (!picker || !trigger) return;

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    if (trigger.disabled) return;
    const open = picker.classList.toggle('open');
    if (open) {
      search.value = '';
      renderProjectList('');
      setTimeout(() => search.focus(), 0);
    }
  });

  search.addEventListener('input', e => renderProjectList(e.target.value));
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { picker.classList.remove('open'); return; }
    const items = Array.from(list.querySelectorAll('.project-item'));
    if (!items.length) return;
    const idx = items.findIndex(el => el.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let n = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      if (n < 0) n = items.length - 1;
      if (n >= items.length) n = 0;
      items.forEach(el => el.classList.remove('active'));
      items[n].classList.add('active');
      items[n].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (items[idx] || items[0]).click();
    }
  });

  list.addEventListener('click', e => {
    const item = e.target.closest('.project-item');
    if (!item) return;
    state.CURRENT_PROJECT_ID = item.dataset.id;
    localStorage.setItem(STORAGE_KEYS.project, state.CURRENT_PROJECT_ID);
    picker.classList.remove('open');
    renderProjectSelect();
    onSelectCb();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#project-picker')) picker.classList.remove('open');
  });
}
