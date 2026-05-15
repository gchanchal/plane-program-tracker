import { Activity, UserCircle2, CheckSquare, CalendarClock, Users, TrendingUp, ListTree } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import type { TabKey } from '@/lib/use-tab';

const TABS: Array<{ key: TabKey; label: string; Icon: typeof Activity }> = [
  { key: 'pulse',    label: 'Pulse',         Icon: Activity },
  { key: 'mywork',   label: 'My Work',       Icon: UserCircle2 },
  { key: 'action',   label: 'Action Center', Icon: CheckSquare },
  { key: 'due',      label: 'Due Work',      Icon: CalendarClock },
  { key: 'capacity', label: 'Capacity',      Icon: Users },
  { key: 'flow',     label: 'Flow',          Icon: TrendingUp },
  { key: 'explorer', label: 'Explorer',      Icon: ListTree },
];

export function Tabs({ tab, setTab }: { tab: TabKey; setTab: (t: TabKey) => void }) {
  const { actions } = useDashboard();
  const actionCount = actions
    ? Object.values(actions).reduce((acc, b) => acc + b.items.length, 0)
    : 0;

  return (
    <nav className="flex gap-1 border-b border-border">
      {TABS.map(t => {
        const active = tab === t.key;
        const showBadge = t.key === 'action' && actionCount > 0;
        const sev = actionCount > 20 ? 'bad' : actionCount > 5 ? 'warn' : '';
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
              (active
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
          </button>
        );
      })}
    </nav>
  );
}
