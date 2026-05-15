/** Pure formatters and small derivation helpers. */

import { PRIORITY_INFO } from './constants';
import type { DashboardData, Priority, ProjectSummary, StateGroup } from './types';

export function fmtShortDate(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function daysBetween(aIso?: string, bIso?: string): number | null {
  if (!aIso || !bIso) return null;
  return Math.floor((new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000);
}

export function isoWeekStart(d: string | Date): string {
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  return x.toISOString().slice(0, 10);
}

export function thirtyDaysAgoIso(today: string): string {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

export function prioCls(p?: Priority): string {
  return p && PRIORITY_INFO[p] ? PRIORITY_INFO[p].cls : 'b-none';
}

export function stateCls(g?: StateGroup, data?: DashboardData | null): string {
  return data?.state_group_info?.[g as StateGroup]?.cls ?? 'b-backlog';
}

export function projectPrefix(project?: ProjectSummary | null): string {
  return project?.identifier || 'ITEM';
}

export function planeItemUrl(seq: number, project: ProjectSummary | null, meta?: { workspace_slug?: string }): string {
  const ws = meta?.workspace_slug || 'plane';
  return `https://app.plane.so/${ws}/browse/${projectPrefix(project)}-${seq}/`;
}

export function countSeverity(n: number, warnAt: number, badAt: number): 'low' | 'warn' | 'bad' {
  if (n === 0) return 'low';
  if (n >= badAt) return 'bad';
  if (n >= warnAt) return 'warn';
  return 'low';
}
