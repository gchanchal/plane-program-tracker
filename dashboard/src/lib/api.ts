/** /api/* fetch wrappers. Mirrors static/js/api.js. */

import type { DashboardData, HistorySnapshot, ProjectsResponse, WorkItemComment } from './types';

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

export const api = {
  projects(): Promise<ProjectsResponse> {
    return jsonFetch('/api/projects', { cache: 'no-store' });
  },

  data(projectId: string): Promise<DashboardData> {
    return jsonFetch(`/api/data?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
  },

  async history(projectId: string): Promise<HistorySnapshot[]> {
    try {
      const body = await jsonFetch<{ history?: HistorySnapshot[] }>(
        `/api/history?project_id=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' }
      );
      return body.history || [];
    } catch {
      return [];
    }
  },

  refresh(projectId: string): Promise<unknown> {
    return jsonFetch(`/api/refresh?project_id=${encodeURIComponent(projectId)}`, { method: 'POST' });
  },

  patchWorkItem(projectId: string, itemId: string, patch: Record<string, unknown>): Promise<unknown> {
    return jsonFetch('/api/work-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, item_id: itemId, patch }),
    });
  },

  addComment(projectId: string, itemId: string, commentHtml: string): Promise<unknown> {
    return jsonFetch('/api/work-item-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, item_id: itemId, comment_html: commentHtml }),
    });
  },

  async listComments(projectId: string, itemId: string): Promise<WorkItemComment[]> {
    const body = await jsonFetch<{ comments?: WorkItemComment[] }>(
      `/api/work-item-comments?project_id=${encodeURIComponent(projectId)}&item_id=${encodeURIComponent(itemId)}`,
      { cache: 'no-store' },
    );
    return body.comments || [];
  },

  me(): Promise<{ email: string | null; user_id: string | null; display_name: string | null; auth_enabled: boolean }> {
    return jsonFetch('/api/me', { cache: 'no-store' });
  },
};
