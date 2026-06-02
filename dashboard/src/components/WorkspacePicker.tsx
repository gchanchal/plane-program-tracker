import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Check, ChevronDown, Plus, Building2 } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { segmentForKey, keyForSegment, DEFAULT_TAB } from '@/lib/tabs';

// Dropdown to switch between workspaces the user has added (the PAT API can't
// enumerate them), plus an inline "add" to validate & remember a new one.
export function WorkspacePicker() {
  const { workspaces, workspaceSlug, addWorkspace } = useDashboard();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = location.pathname.split('/').filter(Boolean)[1];
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Use mousedown, not click: clicking an item that removes itself from the DOM
    // (e.g. the "Add workspace" button switching to the input) would otherwise make
    // contains(e.target) false on the trailing click and wrongly close the menu.
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setAdding(false); } };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => { if (adding) setTimeout(() => inputRef.current?.focus(), 0); }, [adding]);

  // Keep the current tab when switching workspace.
  const currentTabKey = (tab && keyForSegment(tab)) || DEFAULT_TAB;
  const switchTo = (ws: string) => {
    setOpen(false);
    navigate(`/${ws}/${segmentForKey(currentTabKey)}`);
  };

  const submitAdd = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      await addWorkspace(url.trim());  // validates, remembers, navigates into it
      setUrl(''); setAdding(false); setOpen(false);
    } catch (e) {
      setErr((e as Error).message || 'Could not add workspace');
    } finally {
      setBusy(false);
    }
  };

  const list = workspaces || [];
  const label = workspaceSlug || 'Select workspace';

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="inline-flex items-center gap-1.5 px-2 h-7 rounded-md border border-border bg-card text-sm hover:bg-accent transition-colors max-w-[200px]"
        title="Switch workspace"
      >
        <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
      </button>
      {open && (
        <div className="absolute z-40 left-0 top-full mt-1 min-w-[240px] bg-card border border-border rounded-md shadow-lg p-1">
          {list.length === 0 && !adding && (
            <div className="px-2 py-2 text-xs text-muted-foreground">No workspaces yet — add one below.</div>
          )}
          {list.map(ws => (
            <button
              key={ws}
              type="button"
              onClick={() => switchTo(ws)}
              className={'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left ' + (ws === workspaceSlug ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent')}
            >
              <Check className={'h-3.5 w-3.5 shrink-0 ' + (ws === workspaceSlug ? 'opacity-100' : 'opacity-0')} />
              <span className="truncate">{ws}</span>
            </button>
          ))}
          <div className="border-t border-border mt-1 pt-1">
            {!adding ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-foreground hover:bg-accent"
              >
                <Plus className="h-3.5 w-3.5" /> Add workspace
              </button>
            ) : (
              <div className="px-2 py-1.5">
                <input
                  ref={inputRef}
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') setAdding(false); }}
                  placeholder="app.plane.so/your-workspace"
                  className="w-full px-2 py-1 text-sm rounded border border-border bg-background outline-none focus:border-ring"
                />
                {err && <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</div>}
                <div className="mt-1.5 flex gap-1.5">
                  <button type="button" onClick={submitAdd} disabled={busy || !url.trim()} className="px-2 py-1 text-xs rounded bg-foreground text-background disabled:opacity-50">
                    {busy ? 'Adding…' : 'Add'}
                  </button>
                  <button type="button" onClick={() => { setAdding(false); setErr(null); }} className="px-2 py-1 text-xs rounded border border-border hover:bg-accent">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
