/**
 * Inline Fix forms in Action Center. Each bucket has its own form shape:
 *   past_due / missing_dates → date input(s) → PATCH start_date / target_date
 *   unassigned_urgent       → owner dropdown → PATCH assignees
 *   aging_wip / stale       → state dropdown → PATCH state
 * Submit goes through /api/work-item; on success we trigger a project refresh.
 */
import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { patchWorkItem, currentProjectId } from './api.js';

const FIX_SUGGESTIONS = {
  past_due:          '<strong>Set a realistic target date.</strong> If the work is genuinely complete, change the state to Done instead.',
  aging_wip:         '<strong>Long WIP usually means blocked.</strong> Either move it forward (In Review / Done) or back to a holding state. Don’t leave it lingering.',
  stale:             '<strong>Touch the item.</strong> Change state to reflect reality — if it’s no longer being worked, move it back to backlog or close it.',
  unassigned_urgent: '<strong>Pick an owner who can pick this up this week.</strong> Urgent/high work without an assignee is the most common silent slip.',
  missing_dates:     '<strong>Add at least a target date</strong> so the item shows up in capacity/roadmap views.',
};

/** Filter out the server's "User abc12345" fallback names (nameless service accounts). */
const isNameless = n => !n || /^User [0-9a-f]{8}$/i.test(n);

function renderControls(bucketKey, item) {
  if (bucketKey === 'past_due') {
    return `<label>New target</label>
      <input type="date" data-field="target_date" value="${item.end || ''}" />
      <button class="action-fix-save" data-action="save-fix" data-item="${item.id}">Save</button>`;
  }
  if (bucketKey === 'missing_dates') {
    return `<label>Start</label><input type="date" data-field="start_date" value="${item.start || ''}" />
      <label>Target</label><input type="date" data-field="target_date" value="${item.end || ''}" />
      <button class="action-fix-save" data-action="save-fix" data-item="${item.id}">Save dates</button>`;
  }
  if (bucketKey === 'unassigned_urgent') {
    const opts = Object.entries(state.DATA.users || {})
      .filter(([, name]) => !isNameless(name))
      .sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
      .map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
    return `<label>Owner</label>
      <select data-field="assignees_single"><option value="">— choose —</option>${opts}</select>
      <button class="action-fix-save" data-action="save-fix" data-item="${item.id}">Assign</button>`;
  }
  if (bucketKey === 'aging_wip' || bucketKey === 'stale') {
    const states = state.DATA.states_list || [];
    if (!states.length) return '';
    const groupOrder = ['started', 'completed', 'unstarted', 'backlog', 'cancelled'];
    const sorted = states.slice().sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
    const opts = sorted.map(s => `<option value="${s.id}">${escapeHtml(s.name)} · ${s.group}</option>`).join('');
    return `<label>Move to state</label>
      <select data-field="state"><option value="">— choose —</option>${opts}</select>
      <button class="action-fix-save" data-action="save-fix" data-item="${item.id}">Update</button>`;
  }
  return '';
}

export function renderFixForm(bucketKey, item) {
  if ((bucketKey === 'aging_wip' || bucketKey === 'stale') && !(state.DATA.states_list || []).length) {
    return `<div class="action-fix-suggestion">${FIX_SUGGESTIONS[bucketKey]}</div>
            <div class="action-fix-msg err">No states cached — refresh first.</div>`;
  }
  return `<div class="action-fix-suggestion">${FIX_SUGGESTIONS[bucketKey] || ''}</div>
          <div class="action-fix-controls">${renderControls(bucketKey, item)}</div>
          <div class="action-fix-msg"></div>`;
}

export function toggleFix(bucketKey, itemId) {
  const panel = document.getElementById(`fix-${bucketKey}-${itemId}`);
  const row   = document.getElementById(`row-${bucketKey}-${itemId}`);
  if (!panel) return;
  const open = panel.classList.toggle('open');
  if (row) row.classList.toggle('with-fix-open', open);
  if (open) {
    const item = state.CURRENT_ACTIONS?.[bucketKey]?.items.find(i => i.id === itemId);
    if (item) panel.innerHTML = renderFixForm(bucketKey, item);
  }
}

/** Read every [data-field] input/select in the panel and build a Plane patch. */
function collectPatch(panel) {
  const patch = {};
  panel.querySelectorAll('[data-field]').forEach(el => {
    const f = el.dataset.field;
    const v = el.value;
    if (!v) return;
    if (f === 'assignees_single') patch.assignees = [v];
    else patch[f] = v;
  });
  return patch;
}

export async function applyFix(itemId, btn, onSuccess) {
  const panel = btn.closest('.action-fix-panel');
  const msg = panel.querySelector('.action-fix-msg');
  const patch = collectPatch(panel);
  if (Object.keys(patch).length === 0) {
    msg.className = 'action-fix-msg err';
    msg.textContent = 'Pick a value first.';
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Saving…';
  msg.className = 'action-fix-msg';
  msg.textContent = '';
  try {
    await patchWorkItem(currentProjectId(), itemId, patch);
    msg.className = 'action-fix-msg ok';
    msg.textContent = 'Updated. Refreshing dashboard…';
    await onSuccess();
  } catch (e) {
    msg.className = 'action-fix-msg err';
    msg.textContent = 'Failed: ' + e.message;
    btn.disabled = false;
    btn.textContent = original;
  }
}
