/** /api/* fetch wrappers. Mirrors static/js/api.js. */

import type { DashboardData, DueDateChanges, HistorySnapshot, ProjectsResponse, WorkItemComment } from './types';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  let body: unknown = {};
  try { body = await r.json(); } catch { /* ignore */ }
  if (!r.ok) {
    const err = (body as { error?: string }).error || `${init?.method || 'GET'} ${url} → ${r.status}`;
    throw new Error(err);
  }
  return body as T;
}

// All workspace-scoped calls carry ?workspace=<slug>; the server validates it
// against the workspaces the session has added.
const ws = (s: string) => `workspace=${encodeURIComponent(s)}`;

export const api = {
  projects(workspace: string): Promise<ProjectsResponse> {
    return jsonFetch(`/api/projects?${ws(workspace)}`, { cache: 'no-store' });
  },

  data(workspace: string, projectId: string): Promise<DashboardData> {
    return jsonFetch(`/api/data?${ws(workspace)}&project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
  },

  async history(workspace: string, projectId: string): Promise<HistorySnapshot[]> {
    try {
      const body = await jsonFetch<{ history?: HistorySnapshot[] }>(
        `/api/history?${ws(workspace)}&project_id=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' }
      );
      return body.history || [];
    } catch {
      return [];
    }
  },

  refresh(workspace: string, projectId: string): Promise<unknown> {
    return jsonFetch(`/api/refresh?${ws(workspace)}&project_id=${encodeURIComponent(projectId)}`, { method: 'POST' });
  },

  /** Refresh state, incl. background due-date-history progress (due_history_*). */
  status(workspace: string, projectId: string): Promise<{
    in_progress?: boolean;
    due_history_in_progress?: boolean;
    due_history_done?: number;
    due_history_total?: number;
  }> {
    return jsonFetch(`/api/status?${ws(workspace)}&project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
  },

  patchWorkItem(workspace: string, projectId: string, itemId: string, patch: Record<string, unknown>): Promise<unknown> {
    return jsonFetch(`/api/work-item?${ws(workspace)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, item_id: itemId, patch }),
    });
  },

  addComment(workspace: string, projectId: string, itemId: string, commentHtml: string): Promise<unknown> {
    return jsonFetch(`/api/work-item-comment?${ws(workspace)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, item_id: itemId, comment_html: commentHtml }),
    });
  },

  async listComments(workspace: string, projectId: string, itemId: string): Promise<WorkItemComment[]> {
    const body = await jsonFetch<{ comments?: WorkItemComment[] }>(
      `/api/work-item-comments?${ws(workspace)}&project_id=${encodeURIComponent(projectId)}&item_id=${encodeURIComponent(itemId)}`,
      { cache: 'no-store' },
    );
    return body.comments || [];
  },

  /** How many times an item's due date has been moved (from its Plane activity log). */
  dueDateChanges(workspace: string, projectId: string, itemId: string): Promise<DueDateChanges> {
    return jsonFetch(
      `/api/work-item-activities?${ws(workspace)}&project_id=${encodeURIComponent(projectId)}&item_id=${encodeURIComponent(itemId)}`,
      { cache: 'no-store' },
    );
  },

  /** Validate + remember a workspace (by URL or slug). Returns the updated list. */
  addWorkspace(url: string): Promise<{ ok: boolean; workspace_slug: string; workspaces: string[] }> {
    return jsonFetch('/api/workspaces/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  },

  me(): Promise<{ email: string | null; user_id: string | null; display_name: string | null; workspaces: string[]; workspace_slug: string; auth_enabled: boolean }> {
    return jsonFetch('/api/me', { cache: 'no-store' });
  },
};
