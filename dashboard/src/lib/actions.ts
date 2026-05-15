/** Compute Action Center buckets from a DashboardData payload. */

import { PRIORITY_RANK, THRESHOLDS } from './constants';
import { daysBetween } from './format';
import type { ActionBuckets, DashboardData } from './types';

export function computeActions(data: DashboardData | null): ActionBuckets | null {
  if (!data) return null;
  const today = new Date(data.today + 'T00:00:00Z');
  const buckets: ActionBuckets = {
    past_due:          { items: [], title: 'Past target date',         desc: 'Active items whose target date has passed', icon: 'ti-calendar-x' },
    aging_wip:         { items: [], title: 'Aging WIP',                desc: `In progress > ${THRESHOLDS.agingWipDays} days (approx via created_at)`, icon: 'ti-hourglass' },
    stale:             { items: [], title: 'Stale',                    desc: `Active items not updated in > ${THRESHOLDS.staleDays} days`, icon: 'ti-snowflake' },
    unassigned_urgent: { items: [], title: 'Unassigned (urgent/high)', desc: 'High-priority work without an owner', icon: 'ti-user-question' },
    missing_dates:     { items: [], title: 'Missing dates',            desc: 'Active items missing start or target date', icon: 'ti-calendar-question' },
  };

  for (const i of data.items) {
    const sg = i.state_group;
    const isClosed = sg === 'completed' || sg === 'cancelled';
    const isActive = sg === 'started' || sg === 'unstarted';

    if (i.end && !isClosed) {
      const target = new Date(i.end + 'T00:00:00Z');
      if (target < today) {
        const late = Math.floor((today.getTime() - target.getTime()) / 86400000);
        buckets.past_due.items.push({ ...i, _metric: late, _metricStr: late + 'd late' });
      }
    }
    if (sg === 'started' && i.created_at) {
      const age = daysBetween(i.created_at, data.today);
      if (age !== null && age > THRESHOLDS.agingWipDays) {
        buckets.aging_wip.items.push({ ...i, _metric: age, _metricStr: age + 'd in WIP' });
      }
    }
    if (isActive && i.updated_at) {
      const stale = daysBetween(i.updated_at, data.today);
      if (stale !== null && stale > THRESHOLDS.staleDays) {
        buckets.stale.items.push({ ...i, _metric: stale, _metricStr: stale + 'd idle' });
      }
    }
    if (!i.assignee && (i.priority === 'urgent' || i.priority === 'high') && !isClosed) {
      const rank = i.priority === 'urgent' ? 2 : 1;
      buckets.unassigned_urgent.items.push({ ...i, _metric: rank, _metricStr: i.priority });
    }
    if (isActive && (!i.start || !i.end)) {
      const gaps = !i.start && !i.end ? 'no start/target' : !i.start ? 'no start' : 'no target';
      buckets.missing_dates.items.push({ ...i, _metric: 0, _metricStr: gaps });
    }
  }

  for (const k of Object.keys(buckets) as Array<keyof ActionBuckets>) {
    buckets[k].items.sort((a, b) => {
      const pd = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
      return pd || ((b._metric || 0) - (a._metric || 0));
    });
  }
  return buckets;
}
