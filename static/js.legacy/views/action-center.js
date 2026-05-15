/**
 * Action Center: compute the 5 actionable buckets, render them with Fix
 * buttons and inline forms. Bucket definitions:
 *   past_due          — target_date < today, not completed
 *   aging_wip         — in 'started' group AND created > N days ago (approx)
 *   stale             — active AND updated_at > N days ago
 *   unassigned_urgent — no assignee AND priority ∈ {urgent, high}
 *   missing_dates     — active AND missing start_date or target_date
 */
import { state } from './../state.js';
import { THRESHOLDS, PRIORITY_INFO, PRIORITY_RANK } from './../constants.js';
import {
  escapeHtml, prioCls, daysBetween, projectPrefix, planeItemUrl, countSeverity,
} from './../utils.js';
import { switchTab } from './../tabs.js';

const SEV_BY_KEY = {
  past_due:          [1,  5],
  aging_wip:         [3, 10],
  stale:             [5, 15],
  unassigned_urgent: [1,  3],
  missing_dates:     [5, 15],
};

const ORDER = ['past_due', 'aging_wip', 'stale', 'unassigned_urgent', 'missing_dates'];

export function computeActions() {
  if (!state.DATA) return null;
  const today = new Date(state.DATA.today + 'T00:00:00Z');
  const buckets = {
    past_due:          { items: [], title: 'Past target date',         desc: 'Active items whose target date has passed',                                       icon: 'ti-calendar-x' },
    aging_wip:         { items: [], title: 'Aging WIP',                desc: `In progress > ${THRESHOLDS.agingWipDays} days (approx via created_at)`,           icon: 'ti-hourglass' },
    stale:             { items: [], title: 'Stale',                    desc: `Active items not updated in > ${THRESHOLDS.staleDays} days`,                       icon: 'ti-snowflake' },
    unassigned_urgent: { items: [], title: 'Unassigned (urgent/high)', desc: 'High-priority work without an owner',                                              icon: 'ti-user-question' },
    missing_dates:     { items: [], title: 'Missing dates',            desc: 'Active items missing start or target date',                                        icon: 'ti-calendar-question' },
  };

  for (const i of state.DATA.items) {
    const sg = i.state_group;
    const isClosed = sg === 'completed' || sg === 'cancelled';
    const isActive = sg === 'started' || sg === 'unstarted';

    if (i.end && !isClosed) {
      const target = new Date(i.end + 'T00:00:00Z');
      if (target < today) {
        const late = Math.floor((today - target) / 86400000);
        buckets.past_due.items.push({ ...i, _metric: late, _metricStr: late + 'd late' });
      }
    }
    if (sg === 'started' && i.created_at) {
      const age = daysBetween(i.created_at, state.DATA.today);
      if (age !== null && age > THRESHOLDS.agingWipDays) {
        buckets.aging_wip.items.push({ ...i, _metric: age, _metricStr: age + 'd in WIP' });
      }
    }
    if (isActive && i.updated_at) {
      const stale = daysBetween(i.updated_at, state.DATA.today);
      if (stale !== null && stale > THRESHOLDS.staleDays) {
        buckets.stale.items.push({ ...i, _metric: stale, _metricStr: stale + 'd idle' });
      }
    }
    if (!i.assignee && (i.priority === 'urgent' || i.priority === 'high') && !isClosed) {
      const rank = i.priority === 'urgent' ? 2 : 1;
      buckets.unassigned_urgent.items.push({ ...i, _metric: rank, _metricStr: i.priority });
    }
    if (isActive && (!i.start || !i.end)) {
      const gaps = (!i.start && !i.end) ? 'no start/target' : (!i.start ? 'no start' : 'no target');
      buckets.missing_dates.items.push({ ...i, _metric: 0, _metricStr: gaps });
    }
  }

  // Sort each bucket: highest priority first, then biggest metric.
  for (const k of Object.keys(buckets)) {
    buckets[k].items.sort((a, b) => {
      const pd = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
      return pd || ((b._metric || 0) - (a._metric || 0));
    });
  }
  return buckets;
}

function renderRow(bucketKey, it) {
  const prio = PRIORITY_INFO[it.priority] || PRIORITY_INFO.none;
  const url = planeItemUrl(it.seq);
  return `
    <div class="action-row" id="row-${bucketKey}-${it.id}">
      <span class="badge ${prioCls(it.priority)}">${prio.label}</span>
      <a class="action-seq" href="${url}" target="_blank" rel="noopener">${projectPrefix()}-${it.seq}</a>
      <span class="action-name"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(it.name)}</a></span>
      <span class="action-meta">${it.assignee ? escapeHtml(it.assignee) : '<em style="color:#A09C92">unassigned</em>'} · ${escapeHtml(it.state)}</span>
      <span class="action-metric">${it._metricStr}</span>
      <button class="action-fix-btn" data-action="toggle-fix" data-key="${bucketKey}" data-item="${it.id}"><i class="ti ti-tool"></i>Fix</button>
    </div>
    <div class="action-fix-panel" id="fix-${bucketKey}-${it.id}" data-key="${bucketKey}" data-item="${it.id}"></div>`;
}

export function renderActionBuckets() {
  const host = document.getElementById('action-buckets');
  if (!host) return;
  if (!state.CURRENT_ACTIONS) { host.innerHTML = ''; return; }
  host.innerHTML = ORDER.map(key => {
    const b = state.CURRENT_ACTIONS[key];
    const n = b.items.length;
    const [w, bd] = SEV_BY_KEY[key];
    const sev = countSeverity(n, w, bd);
    const rows = n === 0
      ? `<div class="action-empty">Nothing here — good.</div>`
      : b.items.slice(0, 50).map(it => renderRow(key, it)).join('');
    const more = n > 50 ? `<div class="action-empty">+ ${n - 50} more (showing top 50)</div>` : '';
    return `
      <div class="action-bucket" id="bucket-${key}" data-key="${key}">
        <div class="action-bucket-head" data-action="toggle-bucket" data-key="${key}">
          <i class="ti ti-chevron-right action-bucket-chev"></i>
          <i class="ti ${b.icon} action-bucket-icon"></i>
          <div class="action-bucket-info">
            <div class="action-bucket-title">${b.title}</div>
            <div class="action-bucket-desc">${b.desc}</div>
          </div>
          <span class="action-bucket-count ${sev}">${n}</span>
        </div>
        <div class="action-bucket-list">${rows}${more}</div>
      </div>`;
  }).join('');
}

export function toggleBucket(key) {
  const el = document.getElementById('bucket-' + key);
  if (el) el.classList.toggle('open');
}

/** Switch to Action Center tab and scroll/expand a bucket. */
export function jumpToBucket(key) {
  switchTab('action');
  setTimeout(() => {
    const el = document.getElementById('bucket-' + key);
    if (el) {
      el.classList.add('open');
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 50);
}
