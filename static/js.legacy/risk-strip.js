/**
 * The 4-chip risk strip above the tab bar. Reads CURRENT_ACTIONS and renders
 * Past-due / Aging WIP / Stale / Unassigned-urgent counts. Each chip jumps to
 * the corresponding bucket in Action Center.
 */
import { state } from './state.js';
import { countSeverity } from './utils.js';

const CELLS = [
  { key: 'past_due',          icon: 'ti-calendar-x',    label: 'Past due',          warnAt: 1, badAt: 5  },
  { key: 'aging_wip',         icon: 'ti-hourglass',     label: 'Aging WIP',         warnAt: 3, badAt: 10 },
  { key: 'stale',             icon: 'ti-snowflake',     label: 'Stale',             warnAt: 5, badAt: 15 },
  { key: 'unassigned_urgent', icon: 'ti-user-question', label: 'Unassigned urgent', warnAt: 1, badAt: 3  },
];

export function renderRiskStrip() {
  const strip = document.getElementById('risk-strip');
  if (!strip) return;
  if (!state.CURRENT_ACTIONS) { strip.innerHTML = ''; return; }
  strip.innerHTML = CELLS.map(c => {
    const n = state.CURRENT_ACTIONS[c.key].items.length;
    const sev = countSeverity(n, c.warnAt, c.badAt);
    return `<div class="risk-chip ${sev}" data-bucket="${c.key}">
      <i class="ti ${c.icon}"></i>
      <div>
        <div class="risk-chip-num">${n}</div>
        <div class="risk-chip-label">${c.label}</div>
      </div>
    </div>`;
  }).join('');
}

/** One-time click delegation for risk chips. */
export function attachRiskStrip(onJump) {
  const strip = document.getElementById('risk-strip');
  if (!strip) return;
  strip.addEventListener('click', e => {
    const chip = e.target.closest('.risk-chip');
    if (chip) onJump(chip.dataset.bucket);
  });
}
