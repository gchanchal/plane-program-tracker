import { Activity, UserCircle2, CheckSquare, CalendarClock, Users, TrendingUp, ListTree, Map as MapIcon } from 'lucide-react';

// Central tab registry. Each tab maps to a URL path and renders a view component
// that lives in its own file under components/views (or RoadmapTimeline). Both the
// nav (Tabs) and the router (App) read from here so paths and labels stay in sync.
export type TabKey = 'pulse' | 'roadmap' | 'mywork' | 'action' | 'due' | 'capacity' | 'flow' | 'explorer';

export interface TabDef {
  key: TabKey;
  path: string;
  label: string;
  Icon: typeof Activity;
}

export const TABS: TabDef[] = [
  { key: 'pulse',    path: '/pulse',         label: 'Pulse',         Icon: Activity },
  { key: 'roadmap',  path: '/roadmap',       label: 'Roadmap',       Icon: MapIcon },
  { key: 'mywork',   path: '/my-work',       label: 'My Work',       Icon: UserCircle2 },
  { key: 'action',   path: '/action-center', label: 'Action Center', Icon: CheckSquare },
  { key: 'due',      path: '/due-work',      label: 'Due Work',      Icon: CalendarClock },
  { key: 'capacity', path: '/capacity',      label: 'Capacity',      Icon: Users },
  { key: 'flow',     path: '/flow',          label: 'Flow',          Icon: TrendingUp },
  { key: 'explorer', path: '/explorer',      label: 'Explorer',      Icon: ListTree },
];

export const DEFAULT_TAB: TabKey = 'pulse';

export function pathForKey(key: TabKey): string {
  return TABS.find(t => t.key === key)?.path ?? TABS[0].path;
}

export function keyForPath(path: string): TabKey | undefined {
  return TABS.find(t => t.path === path)?.key;
}
