import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useDashboard } from '@/lib/dashboard-context';
import { relativeTime } from '@/lib/format';
import { TABS, segmentForKey } from '@/lib/tabs';

export function Tabs() {
  const { actions, data, workspaceSlug, selectedProjectParam } = useDashboard();
  // Until we know the workspace, tabs have nowhere to link.
  if (!workspaceSlug) return null;
  // Carry the selected project(s) on every tab link so switching tabs keeps them.
  const projQuery = selectedProjectParam ? `?projects=${selectedProjectParam}` : '';
  const actionCount = actions
    ? Object.values(actions).reduce((acc, b) => acc + b.items.length, 0)
    : 0;

  // Tick once a minute so "X mins ago" stays current without a server hit.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const lastIso = data?._meta?.last_refreshed_at;

  return (
    <nav className="flex items-center gap-1 border-b border-border">
      {TABS.map(t => {
        const showBadge = t.key === 'action' && actionCount > 0;
        const sev = actionCount > 20 ? 'bad' : actionCount > 5 ? 'warn' : '';
        return (
          <NavLink
            key={t.key}
            to={`/${workspaceSlug}/${segmentForKey(t.key)}${projQuery}`}
            className={({ isActive }) =>
              'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
              (isActive
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            <t.Icon className="h-4 w-4" />
            {t.label}
            {showBadge && (
              <span className={'ml-1 inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full text-[10px] font-semibold ' +
                (sev === 'bad' ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                  : sev === 'warn' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    : 'bg-muted text-muted-foreground')}>
                {actionCount}
              </span>
            )}
          </NavLink>
        );
      })}
      {lastIso && (
        <span
          className="ml-auto pb-2 text-xs text-muted-foreground whitespace-nowrap"
          title={`Last refreshed ${new Date(lastIso).toLocaleString()}`}
        >
          Last refresh: {relativeTime(lastIso)}
        </span>
      )}
    </nav>
  );
}
