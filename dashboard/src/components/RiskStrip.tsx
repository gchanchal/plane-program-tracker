import { CalendarX, Hourglass, Snowflake, UserX } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { countSeverity } from '@/lib/format';
import type { ActionBucketKey } from '@/lib/types';

const CELLS: Array<{
  key: ActionBucketKey;
  label: string;
  warnAt: number;
  badAt: number;
  Icon: typeof CalendarX;
}> = [
  { key: 'past_due',          label: 'Past due',          warnAt: 1, badAt: 5,  Icon: CalendarX },
  { key: 'aging_wip',         label: 'Aging WIP',         warnAt: 3, badAt: 10, Icon: Hourglass },
  { key: 'stale',             label: 'Stale',             warnAt: 5, badAt: 15, Icon: Snowflake },
  { key: 'unassigned_urgent', label: 'Unassigned urgent', warnAt: 1, badAt: 3,  Icon: UserX },
];

export function RiskStrip({ onJump }: { onJump: (k: ActionBucketKey) => void }) {
  const { actions } = useDashboard();
  if (!actions) return <div className="grid grid-cols-4 gap-3 py-2" />;
  return (
    <div className="grid grid-cols-4 gap-3 py-2">
      {CELLS.map(c => {
        const n = actions[c.key].items.length;
        const sev = countSeverity(n, c.warnAt, c.badAt);
        return (
          <div key={c.key} className={'risk-chip ' + sev} onClick={() => onJump(c.key)}>
            <c.Icon className="h-4 w-4" />
            <div>
              <div className="risk-chip-num">{n}</div>
              <div className="risk-chip-label">{c.label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
