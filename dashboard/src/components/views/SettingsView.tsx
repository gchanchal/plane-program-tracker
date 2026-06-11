/**
 * Settings → cache management. Lists the data files the server maintains per
 * workspace → project. Deleting a project's cache removes its data + raw + history
 * files, so the next refresh for it is a full rebuild instead of an incremental
 * delta. (A delta refresh reuses the raw cache; a full one re-pulls the window.)
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash2, RefreshCw, Database, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import type { CacheEntry } from '@/lib/types';

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function SettingsView() {
  const [entries, setEntries] = useState<CacheEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setEntries(await api.cacheList());
    } catch (e) {
      setErr((e as Error).message);
      setEntries([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onDelete = async (e: CacheEntry) => {
    const key = `${e.workspace_slug}:${e.project_id}`;
    const label = e.project_name || e.project_id;
    if (!window.confirm(
      `Delete cached data for "${label}"?\n\nThis removes its data, raw, and history files. ` +
      `The next refresh will do a full rebuild (slower) and trend history will be lost.`,
    )) return;
    setBusyKey(key);
    setErr(null);
    try {
      await api.cacheDelete(e.workspace_slug, e.project_id);
      await load();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const byWorkspace = (entries || []).reduce<Record<string, CacheEntry[]>>((acc, e) => {
    (acc[e.workspace_slug] ||= []).push(e);
    return acc;
  }, {});

  return (
    <div className="max-w-[1100px] mx-auto py-2">
      <div className="flex items-center gap-2 mb-1">
        <Database className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold tracking-tight">Cache &amp; data files</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        One cache per workspace → project. Refreshes are <strong>incremental</strong> when a cache exists
        (only items changed since the last refresh are pulled) and a <strong>full rebuild</strong> when it
        doesn’t. Delete a project’s cache to force a clean full rebuild on its next refresh.
      </p>

      {err && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md text-[13px] text-red-700 dark:text-red-400 bg-red-500/10">
          <AlertTriangle className="h-4 w-4" />{err}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">
          {entries === null ? 'Loading…' : `${entries.length} cached project${entries.length === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md border border-border bg-card text-xs hover:bg-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Reload
        </button>
      </div>

      {entries !== null && entries.length === 0 && (
        <div className="text-sm text-muted-foreground border border-border rounded-lg px-4 py-8 text-center">
          No cached data yet. Refresh a project to build its cache.
        </div>
      )}

      {Object.entries(byWorkspace).map(([ws, rows]) => (
        <div key={ws} className="mb-5">
          <div className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">{ws}</div>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-accent/40 text-muted-foreground text-[11px] uppercase tracking-wider">
                  <th className="text-left font-medium px-3 py-2">Project</th>
                  <th className="text-left font-medium px-3 py-2">Last refresh</th>
                  <th className="text-left font-medium px-3 py-2">Mode</th>
                  <th className="text-right font-medium px-3 py-2">Items</th>
                  <th className="text-right font-medium px-3 py-2">Due history</th>
                  <th className="text-right font-medium px-3 py-2">Size</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const key = `${e.workspace_slug}:${e.project_id}`;
                  const total = e.data_bytes + e.raw_bytes + e.history_bytes;
                  return (
                    <tr key={key} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium">{e.project_name || '—'}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{e.project_id}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtWhen(e.last_refreshed_at)}</td>
                      <td className="px-3 py-2">
                        <span className={'inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ' +
                          (e.has_raw
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                            : 'bg-amber-500/15 text-amber-700 dark:text-amber-400')}>
                          {e.has_raw ? 'delta-ready' : 'full only'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{e.item_count ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {e.due_total ? `${e.due_done ?? 0}/${e.due_total}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground" title={
                        `data ${fmtBytes(e.data_bytes)} · raw ${fmtBytes(e.raw_bytes)} · history ${fmtBytes(e.history_bytes)}`
                      }>
                        {fmtBytes(total)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onDelete(e)}
                          disabled={busyKey === key}
                          className="inline-flex items-center gap-1.5 px-2 h-7 rounded-md border border-border text-[12px] text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                          title="Delete cache (forces a full rebuild next refresh)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {busyKey === key ? 'Deleting…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
