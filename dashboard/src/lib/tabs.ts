import { Activity, UserCircle2, CheckSquare, CalendarClock, Users, TrendingUp, ListTree, Map as MapIcon, BarChart3 } from 'lucide-react';

// Central tab registry. Each tab maps to a URL path and renders a view component
// that lives in its own file under components/views (or RoadmapTimeline). Both the
// nav (Tabs) and the router (App) read from here so paths and labels stay in sync.
export type TabKey = 'pulse' | 'roadmap' | 'mywork' | 'action' | 'due' | 'capacity' | 'flow' | 'reports' | 'explorer';

export interface TabDef {
  key: TabKey;
  /** URL segment for this tab (no slashes). Full URL is /<workspace>/<segment>. */
  segment: string;
  label: string;
  Icon: typeof Activity;
}

export const TABS: TabDef[] = [
  { key: 'pulse',    segment: 'pulse',         label: 'Pulse',         Icon: Activity },
  { key: 'roadmap',  segment: 'roadmap',       label: 'Roadmap',       Icon: MapIcon },
  { key: 'mywork',   segment: 'my-work',       label: 'My Work',       Icon: UserCircle2 },
  { key: 'action',   segment: 'action-center', label: 'Action Center', Icon: CheckSquare },
  { key: 'due',      segment: 'due-work',      label: 'Due Work',      Icon: CalendarClock },
  { key: 'capacity', segment: 'capacity',      label: 'Capacity',      Icon: Users },
  { key: 'flow',     segment: 'flow',          label: 'Flow',          Icon: TrendingUp },
  { key: 'reports',  segment: 'reports',       label: 'Reports',       Icon: BarChart3 },
  { key: 'explorer', segment: 'explorer',      label: 'Explorer',      Icon: ListTree },
];

export const DEFAULT_TAB: TabKey = 'pulse';

export function segmentForKey(key: TabKey): string {
  return TABS.find(t => t.key === key)?.segment ?? TABS[0].segment;
}

export function keyForSegment(segment: string): TabKey | undefined {
  return TABS.find(t => t.segment === segment)?.key;
}

/** Full app URL for a tab within a workspace, e.g. tabUrl('acme', 'roadmap') -> /acme/roadmap */
export function tabUrl(workspace: string, key: TabKey): string {
  return `/${workspace}/${segmentForKey(key)}`;
}
