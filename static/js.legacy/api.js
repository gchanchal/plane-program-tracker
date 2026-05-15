/**
 * Thin wrappers over the server's /api/* endpoints. All network I/O lives here
 * so any future change (auth headers, base URL, retry policy) is one place.
 */
import { state } from './state.js';

async function jsonFetch(url, init) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${init?.method || 'GET'} ${url} → ${r.status}`);
  return body;
}

export async function fetchProjects() {
  const body = await jsonFetch('/api/projects', { cache: 'no-store' });
  return body;  // { projects, default_project_id }
}

export async function fetchProjectData(projectId) {
  return jsonFetch(`/api/data?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
}

export async function fetchHistory(projectId) {
  try {
    const body = await jsonFetch(`/api/history?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    return body.history || [];
  } catch (_) {
    return [];
  }
}

export async function refreshProject(projectId) {
  return jsonFetch(`/api/refresh?project_id=${encodeURIComponent(projectId)}`, { method: 'POST' });
}

export async function patchWorkItem(projectId, itemId, patch) {
  return jsonFetch('/api/work-item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, item_id: itemId, patch }),
  });
}

// Convenience: use the current project ID from state.
export const currentProjectId = () => state.CURRENT_PROJECT_ID;
