/**
 * App-wide constants: colors, priority/type metadata, thresholds, storage keys.
 * Pure values — no side effects.
 */

// localStorage keys
export const STORAGE_KEYS = {
  project: 'dashboard.selectedProjectId',
  tab:     'dashboard.activeTab',
  theme:   'dashboard.theme',
};

// Thresholds that drive Action Center bucket membership + Capacity overload flags.
export const THRESHOLDS = {
  agingWipDays: 14,   // started_at older than this counts as aging
  staleDays:    7,    // updated_at older than this counts as stale
  wipOverload:  5,    // started count >= overload → red flag
  wipHigh:      3,    // started count >= high   → amber flag
};

// Plane work-item type → display color (used in charts & icons).
export const TYPE_COLORS = {
  Bug:         '#EF5974',
  Task:        '#A0D6FD',
  Improvement: '#4C49F8',
  Feature:     '#FC964D',
  Refactor:    '#8280FF',
  Other:       '#888780',
};

// Plane priority → display metadata.
export const PRIORITY_INFO = {
  urgent: { label: 'Urgent', color: '#A32D2D', cls: 'b-urgent' },
  high:   { label: 'High',   color: '#EF9F27', cls: 'b-high'   },
  medium: { label: 'Medium', color: '#378ADD', cls: 'b-medium' },
  low:    { label: 'Low',    color: '#888780', cls: 'b-low'    },
  none:   { label: 'None',   color: '#B8B4A8', cls: 'b-none'   },
};

// Numeric rank for sorting "highest priority first".
export const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

// Explorer grouping builder — which fields can be used as group-by, in what order.
export const FIELDS = {
  state_group: { label: 'State',    icon: 'ti-progress' },
  priority:    { label: 'Priority', icon: 'ti-flag' },
  type:        { label: 'Type',     icon: 'ti-category' },
  assignee:    { label: 'Assignee', icon: 'ti-user' },
};

// Canonical sort order for each groupable field (when applicable).
export const GROUP_ORDER = {
  state_group: ['started', 'unstarted', 'completed', 'backlog', 'cancelled'],
  priority:    ['urgent', 'high', 'medium', 'low', 'none'],
  type:        ['Bug', 'Feature', 'Task', 'Improvement', 'Refactor', 'Other'],
};
