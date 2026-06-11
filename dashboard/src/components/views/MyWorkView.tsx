import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, AlertCircle, Hourglass, CalendarX } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';
import { PRIORITY_INFO, THRESHOLDS } from '@/lib/constants';
import { daysBetween, planeItemUrl, prioCls, projectPrefix } from '@/lib/format';
import { HBarList } from '@/components/HBarList';
import { PieChart } from '@/components/charts/pie-chart';
import { PieSlice } from '@/components/charts/pie-slice';
import { PieCenter } from '@/components/charts/pie-center';
import { EditWorkItem } from '@/components/EditWorkItem';
import { DueChangesPill } from '@/components/DueChangesPill';
import type { ActionBucketKey, Priority, StateGroup, WorkItem } from '@/lib/types';

const G_ORDER: StateGroup[] = ['completed', 'started', 'unstarted', 'backlog', 'cancelled'];
const P_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

interface UserBuckets {
  past_due: Array<WorkItem & { _metric: number; _metricStr: string }>;
  aging_wip: Array<WorkItem & { _metric: number; _metricStr: string }>;
  missing_dates: Array<WorkItem & { _metric: number; _metricStr: string }>;
}

export function MyWorkView({ onJump: _onJump }: { onJump: (k: ActionBucketKey) => void }) {
  const { data, currentProject } = useDashboard();
  const projIdent = projectPrefix(currentProject);
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);

  useEffect(() => {
    api.me()
      .then((r) => {
        setEmail(r.email);
        setUserId(r.user_id);
        setDisplayName(r.display_name);
        setAuthEnabled(r.auth_enabled);
      })
      .catch(() => { /* unauthenticated requests redirect at server */ });
  }, []);

  /**
   * Resolve the workspace user_id we'll filter assignments by.
   * Priority:
   *   1. `assignee_id` matches `userId` from /users/me/ — sturdiest, no string compare.
   *   2. Plane's display_name (from /users/me/) === a value in `data.users` — exact match.
   *   3. Fuzzy fall-back: first word of email local-part matches first word of a workspace member name.
   */
  const resolvedUserId = useMemo<string | null>(() => {
    if (!data) return null;
    const users = data.users || {};
    // 1) Trust the user_id from /users/me/ if any item in this project is actually assigned to it.
    if (userId && data.items.some(i => i.assignee_id === userId)) return userId;
    // 2) Look up by Plane display_name → workspace member name.
    if (displayName) {
      const want = displayName.trim().toLowerCase();
      for (const uid of Object.keys(users)) {
        if ((users[uid] || '').trim().toLowerCase() === want) return uid;
      }
    }
    // 3) Email-localpart fuzzy fallback (legacy cookies without display_name).
    if (email) {
      const head = email.split('@')[0].toLowerCase().split(/[._-]/)[0];
      for (const uid of Object.keys(users)) {
        const first = (users[uid] || '').split(/\s+/)[0]?.toLowerCase() || '';
        if (first && first === head) return uid;
      }
    }
    // 4) Last resort: trust the cookie user_id even if no items are assigned yet.
    return userId || null;
  }, [data, userId, displayName, email]);

  const myName = useMemo(() => {
    if (!data || !resolvedUserId) return displayName || null;
    return (data.users || {})[resolvedUserId] || displayName || null;
  }, [data, resolvedUserId, displayName]);

  const mine: WorkItem[] = useMemo(() => {
    if (!data || !resolvedUserId) return [];
    return data.items.filter(i => i.assignee_id === resolvedUserId);
  }, [data, resolvedUserId]);

  // KPIs
  const stats = useMemo(() => {
    const wip = mine.filter(i => i.state_group === 'started').length;
    const unstarted = mine.filter(i => i.state_group === 'unstarted').length;
    const backlog = mine.filter(i => i.state_group === 'backlog').length;
    const completed = mine.filter(i => i.state_group === 'completed').length;
    const open = mine.filter(i => i.state_group === 'started' || i.state_group === 'unstarted').length;
    return { wip, unstarted, backlog, completed, open };
  }, [mine]);

  const buckets: UserBuckets = useMemo(() => {
    const out: UserBuckets = { past_due: [], aging_wip: [], missing_dates: [] };
    if (!data) return out;
    const today = new Date(data.today + 'T00:00:00Z');
    for (const i of mine) {
      const sg = i.state_group;
      const isClosed = sg === 'completed' || sg === 'cancelled';
      const isActive = sg === 'started' || sg === 'unstarted';
      if (i.end && !isClosed) {
        const target = new Date(i.end + 'T00:00:00Z');
        if (target < today) {
          const late = Math.floor((today.getTime() - target.getTime()) / 86400000);
          out.past_due.push({ ...i, _metric: late, _metricStr: late + 'd late' });
        }
      }
      if (sg === 'started' && i.created_at) {
        const age = daysBetween(i.created_at, data.today);
        if (age !== null && age > THRESHOLDS.agingWipDays) {
          out.aging_wip.push({ ...i, _metric: age, _metricStr: age + 'd in WIP' });
        }
      }
      if (isActive && (!i.start || !i.end)) {
        const gaps = !i.start && !i.end ? 'no start/target' : !i.start ? 'no start' : 'no target';
        out.missing_dates.push({ ...i, _metric: 0, _metricStr: gaps });
      }
    }
    const prioRank: Record<Priority, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
    for (const k of Object.keys(out) as Array<keyof UserBuckets>) {
      out[k].sort((a, b) =>
        (prioRank[b.priority] - prioRank[a.priority]) || (b._metric - a._metric),
      );
    }
    return out;
  }, [data, mine]);

  const priorityRows = useMemo(() => {
    const counts: Record<Priority, number> = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 };
    for (const i of mine) counts[i.priority] = (counts[i.priority] || 0) + 1;
    return P_ORDER.map(p => ({ label: PRIORITY_INFO[p].label, value: counts[p], color: PRIORITY_INFO[p].color }));
  }, [mine]);

  const stateDonutData = useMemo(() => {
    if (!data) return [];
    const counts: Record<string, number> = {};
    for (const i of mine) counts[i.state_group] = (counts[i.state_group] || 0) + 1;
    return G_ORDER
      .map(g => ({
        label: data.state_group_info[g].label,
        value: counts[g] || 0,
        color: data.state_group_info[g].color,
      }))
      .filter(d => d.value > 0);
  }, [data, mine]);

  // ---- Render ----
  if (!data) return null;

  if (!authEnabled) {
    return (
      <div className="text-sm text-muted-foreground p-6 border border-border rounded-lg bg-card">
        Auth is disabled, so the dashboard doesn't know who "you" are.
        Set <code className="text-foreground">SESSION_SECRET</code> in <code className="text-foreground">.env</code> and sign in with your Plane PAT to use this view.
      </div>
    );
  }

  if (!resolvedUserId) {
    return (
      <div className="text-sm text-muted-foreground p-6 border border-border rounded-lg bg-card">
        Couldn't match <code className="text-foreground">{displayName || email}</code> to a workspace member in this project.
        Sign out and back in if your session predates the display-name fetch, or refresh project data once you've been added as an assignee on at least one item.
      </div>
    );
  }

  if (mine.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-6 border border-border rounded-lg bg-card">
        No items assigned to <strong className="text-foreground">{myName || email}</strong> in this project's window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Showing work assigned to <strong className="text-foreground">{myName || email}</strong>
        {' · '}<strong className="text-foreground">{mine.length}</strong> items in window
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="kpi kpi-cool">
          <div className="kpi-label"><span className="kpi-dot" />Open</div>
          <div className="kpi-value">{stats.open}</div>
          <div className="kpi-sub"><strong>{stats.unstarted}</strong> unstarted · <strong>{stats.backlog}</strong> backlog</div>
        </div>
        <div className="kpi kpi-warm">
          <div className="kpi-label"><span className="kpi-dot" />In progress</div>
          <div className="kpi-value">{stats.wip}</div>
          <div className="kpi-sub"><strong>{buckets.aging_wip.length}</strong> aging &gt; {THRESHOLDS.agingWipDays}d</div>
        </div>
        <div className={'kpi ' + (buckets.past_due.length > 0 ? 'kpi-bad' : 'kpi-good')}>
          <div className="kpi-label"><span className="kpi-dot" />Past due</div>
          <div className="kpi-value">{buckets.past_due.length}</div>
          <div className="kpi-sub">{buckets.past_due.length === 0 ? 'nothing overdue' : 'need rescheduling or unblocking'}</div>
        </div>
        <div className="kpi kpi-good">
          <div className="kpi-label"><span className="kpi-dot" />Completed</div>
          <div className="kpi-value">{stats.completed}</div>
          <div className="kpi-sub">in window</div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="chart-box">
          <h3>Your state distribution</h3>
          {stateDonutData.length === 0 ? (
            <div className="chart-empty">No items.</div>
          ) : (
            <div className="flex items-center justify-center" style={{ minHeight: 220 }}>
              <PieChart data={stateDonutData} innerRadius={70} padAngle={0.02} cornerRadius={3} className="max-w-[220px]">
                {stateDonutData.map((_, i) => <PieSlice key={i} index={i} hoverEffect="grow" />)}
                <PieCenter>
                  {() => (
                    <div className="text-center">
                      <div className="text-2xl font-medium">{stateDonutData.reduce((a, d) => a + d.value, 0)}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">items</div>
                    </div>
                  )}
                </PieCenter>
              </PieChart>
            </div>
          )}
        </div>
        <div className="chart-box">
          <h3>Your work by priority</h3>
          <HBarList rows={priorityRows} />
        </div>
      </section>

      <UserBucketList
        title="Past target date"
        icon={<CalendarX className="h-4 w-4" />}
        desc="Your active items whose target date has passed"
        items={buckets.past_due}
        sev={buckets.past_due.length > 5 ? 'bad' : buckets.past_due.length > 0 ? 'warn' : ''}
        projIdent={projIdent}
        meta={data._meta}
      />
      <UserBucketList
        title="Aging WIP"
        icon={<Hourglass className="h-4 w-4" />}
        desc={`In progress > ${THRESHOLDS.agingWipDays} days`}
        items={buckets.aging_wip}
        sev={buckets.aging_wip.length > 5 ? 'bad' : buckets.aging_wip.length > 0 ? 'warn' : ''}
        projIdent={projIdent}
        meta={data._meta}
      />
      <UserBucketList
        title="Missing dates"
        icon={<AlertCircle className="h-4 w-4" />}
        desc="Active items missing start or target date"
        items={buckets.missing_dates}
        sev=""
        projIdent={projIdent}
        meta={data._meta}
      />
    </div>
  );
}

function UserBucketList({
  title, icon, desc, items, sev, projIdent, meta,
}: {
  title: string;
  icon: React.ReactNode;
  desc: string;
  items: Array<WorkItem & { _metricStr: string }>;
  sev: 'bad' | 'warn' | '';
  projIdent: string;
  meta?: { workspace_slug?: string };
}) {
  const [open, setOpen] = useState(items.length > 0 && items.length <= 6);
  const count = items.length;
  return (
    <div className={'action-bucket' + (open ? ' open' : '')}>
      <div className="action-bucket-head" onClick={() => setOpen(o => !o)}>
        <span className="action-bucket-icon">{icon}</span>
        <div className="action-bucket-info">
          <div className="action-bucket-title">{title}</div>
          <div className="action-bucket-desc">{desc}</div>
        </div>
        <span className={'action-bucket-count ' + sev}>{count}</span>
      </div>
      {open && count > 0 && (
        <div className="action-bucket-list">
          {items.slice(0, 50).map(item => {
            const prio = PRIORITY_INFO[item.priority] || PRIORITY_INFO.none;
            const url = planeItemUrl(item.seq, { id: '', identifier: projIdent }, meta);
            return (
              <div key={item.id} className="action-row" style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto auto auto auto auto', gap: 12, alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                <a href={url} target="_blank" rel="noopener" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  {projIdent}-{item.seq}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <span className="truncate">{item.name}</span>
                <span className={'badge ' + prioCls(item.priority)}>{prio.label}</span>
                <span className="text-muted-foreground text-[11px]">{item.state}</span>
                <span className="text-muted-foreground text-[11px]">{item._metricStr}</span>
                <span className="inline-flex justify-end"><DueChangesPill item={item} /></span>
                <EditWorkItem item={item} />
              </div>
            );
          })}
          {count > 50 && <div className="action-empty">… {count - 50} more not shown</div>}
        </div>
      )}
      {open && count === 0 && <div className="action-empty">Nothing here. ✓</div>}
    </div>
  );
}
