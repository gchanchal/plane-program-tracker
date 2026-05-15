/**
 * Stateless helpers. Two kinds:
 *   - Pure formatters (escapeHtml, fmtShortDate, daysBetween, isoWeekStart…)
 *   - Tiny state-reading helpers (currentProject, projectPrefix, planeItemUrl).
 *     These read from state but don't mutate.
 */
import { state } from './state.js';
import { PRIORITY_INFO } from './constants.js';

/** Escape user-controlled strings for safe HTML interpolation. */
export function escapeHtml(s) {
  return (s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

export function prioCls(p)  { return PRIORITY_INFO[p] ? PRIORITY_INFO[p].cls : 'b-none'; }
export function stateCls(g) { return state.DATA?.state_group_info?.[g]?.cls || 'b-backlog'; }

/** "Nov 12" style short date from an ISO string. */
export function fmtShortDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Whole-day difference between two ISO strings, or null if either is missing. */
export function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  return Math.floor((new Date(bIso) - new Date(aIso)) / 86400000);
}

/** Monday-anchored ISO week start ("YYYY-MM-DD") for a Date / ISO string. */
export function isoWeekStart(d) {
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);  // ISO week starts Monday
  x.setUTCDate(x.getUTCDate() + diff);
  return x.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" 30 days before DATA.today. Used for the 30d completion window. */
export function thirtyDaysAgoIso() {
  const d = new Date(state.DATA.today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

export function currentProject() {
  return state.PROJECTS.find(p => p.id === state.CURRENT_PROJECT_ID) || {};
}
export function projectPrefix() {
  return currentProject().identifier || 'ITEM';
}

/** External link to a Plane work item: app.plane.so/<workspace>/browse/<IDENT>-<seq>/ */
export function planeItemUrl(seq) {
  const meta = state.DATA?._meta || {};
  const ws = meta.workspace_slug || 'plane';
  return `https://app.plane.so/${ws}/browse/${projectPrefix()}-${seq}/`;
}

/** Map a count to a severity class — drives risk-strip and bucket-count colors. */
export function countSeverity(n, warnAt, badAt) {
  if (n === 0)      return 'low';
  if (n >= badAt)   return 'bad';
  if (n >= warnAt)  return 'warn';
  return 'low';
}
