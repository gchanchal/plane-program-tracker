/** App-wide constants ported from static/js/constants.js. */

import type { Priority } from './types';

export const STORAGE_KEYS = {
  project: 'dashboard.selectedProjectId',
  tab: 'dashboard.activeTab',
  theme: 'dashboard.theme',
} as const;

export const THRESHOLDS = {
  agingWipDays: 14,
  staleDays: 7,
  wipOverload: 5,
  wipHigh: 3,
} as const;

export const TYPE_COLORS: Record<string, string> = {
  Bug: '#EF5974',
  Task: '#A0D6FD',
  Improvement: '#4C49F8',
  Feature: '#FC964D',
  Refactor: '#8280FF',
  Other: '#888780',
};

export const PRIORITY_INFO: Record<Priority, { label: string; color: string; cls: string }> = {
  urgent: { label: 'Urgent', color: '#A32D2D', cls: 'b-urgent' },
  high: { label: 'High', color: '#EF9F27', cls: 'b-high' },
  medium: { label: 'Medium', color: '#378ADD', cls: 'b-medium' },
  low: { label: 'Low', color: '#888780', cls: 'b-low' },
  none: { label: 'None', color: '#B8B4A8', cls: 'b-none' },
};

export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 4, high: 3, medium: 2, low: 1, none: 0,
};

export const FIELDS = {
  state_group: { label: 'State', icon: 'ti-progress' },
  priority: { label: 'Priority', icon: 'ti-flag' },
  type: { label: 'Type', icon: 'ti-category' },
  assignee: { label: 'Assignee', icon: 'ti-user' },
} as const;

export type ExplorerField = keyof typeof FIELDS;

export const GROUP_ORDER: Partial<Record<ExplorerField, string[]>> = {
  state_group: ['started', 'unstarted', 'completed', 'backlog', 'cancelled'],
  priority: ['urgent', 'high', 'medium', 'low', 'none'],
  type: ['Bug', 'Feature', 'Task', 'Improvement', 'Refactor', 'Other'],
};
