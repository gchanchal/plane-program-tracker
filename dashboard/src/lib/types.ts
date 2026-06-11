/**
 * TypeScript types mirroring the /api/data response shape from server.py.
 * Keep loose where the server is loose; the dashboard tolerates missing fields.
 */

export type StateGroup = 'started' | 'unstarted' | 'completed' | 'backlog' | 'cancelled';
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export interface WorkItemLabel {
  id: string;
  name: string;
  color?: string;
}

export interface WorkItem {
  id: string;
  seq: number;
  name: string;
  type: string;
  type_color?: string;
  state: string;
  state_group: StateGroup;
  priority: Priority;
  assignee?: string;
  assignee_id?: string;
  assignee_ids?: string[];
  assignee_color?: string;
  parent?: string;
  start?: string;
  end?: string;
  created_at?: string;
  updated_at?: string;
  labels?: WorkItemLabel[];
  description_html?: string;
  description_stripped?: string;
  /** Number of distinct due dates this item has been assigned (>= 2 means rescheduled). Precomputed at refresh. */
  due_count?: number;
  /** Chronological list of every due date assigned, for the reschedule pill's tooltip. */
  due_dates?: string[];
}

export interface StateGroupInfo {
  label: string;
  color: string;
  cls: string;
}

export interface PortfolioBreakdown {
  completed?: number;
  started?: number;
  unstarted?: number;
  backlog?: number;
  cancelled?: number;
  _total: number;
  _workable: number;
  _done: number;
  _pct: number;
}

export interface Portfolio {
  id: string;
  name: string;
  seq: number;
  priority: Priority;
  start_date?: string;
  target_date?: string;
  assignee?: string;
  breakdown: PortfolioBreakdown;
}

export interface StateRecord {
  id: string;
  name: string;
  group: StateGroup;
}

export interface WorkItemComment {
  id: string;
  comment_html?: string;
  comment_stripped?: string;
  created_at?: string;
  updated_at?: string;
  actor?: string;
  actor_detail?: { id: string; display_name?: string; first_name?: string; last_name?: string; avatar_url?: string };
  created_by?: string;
  created_by_detail?: { id: string; display_name?: string; first_name?: string; last_name?: string; avatar_url?: string };
}

export interface DueDateChange {
  from: string;
  to: string | null;
  at?: string;
}

export interface DueDateChanges {
  /** Number of distinct due dates assigned over time (>= 2 means rescheduled). */
  due_count: number;
  /** Chronological list of every due date assigned. */
  due_dates: string[];
  changes: DueDateChange[];
}

export interface DataMeta {
  workspace_slug?: string;
  project_id?: string;
  item_count?: number;
  window_days?: number;
  last_refreshed_at?: string;
}

export interface DashboardData {
  today: string;
  cutoff?: string;
  items: WorkItem[];
  users: Record<string, string>;
  user_colors: Record<string, string>;
  group_counts: Record<StateGroup, number>;
  priority_counts: Record<Priority, number>;
  type_counts: Record<string, number>;
  state_group_info: Record<StateGroup, StateGroupInfo>;
  states_list?: StateRecord[];
  labels_list?: WorkItemLabel[];
  weeks: Array<{ week: string; count: number }>;
  portfolios?: Portfolio[];
  kpi: { total: number };
  _meta?: DataMeta;
}

export interface ProjectSummary {
  id: string;
  name?: string;
  identifier?: string;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  default_project_id?: string;
  workspace_slug?: string;
}

export interface HistorySnapshot {
  ts: string;
  group_counts?: Record<StateGroup, number>;
}

export type ActionBucketKey =
  | 'past_due'
  | 'aging_wip'
  | 'stale'
  | 'unassigned_urgent'
  | 'missing_dates';

export interface ActionItem extends WorkItem {
  _metric: number;
  _metricStr: string;
}

export interface ActionBucket {
  items: ActionItem[];
  title: string;
  desc: string;
  icon: string;
}

export type ActionBuckets = Record<ActionBucketKey, ActionBucket>;
