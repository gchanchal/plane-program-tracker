import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom';
import { ChevronDown, Check } from 'lucide-react';
import { DashboardProvider, useDashboard } from '@/lib/dashboard-context';
import { DEFAULT_TAB, segmentForKey, keyForSegment, tabUrl, type TabKey } from '@/lib/tabs';
import { STORAGE_KEYS } from '@/lib/constants';
import { Topbar } from '@/components/Topbar';
import { Tabs } from '@/components/Tabs';
import { PulseView } from '@/components/views/PulseView';
import { MyWorkView } from '@/components/views/MyWorkView';
import { ActionCenterView } from '@/components/views/ActionCenterView';
import { DueWorkView } from '@/components/views/DueWorkView';
import { CapacityView } from '@/components/views/CapacityView';
import { FlowView } from '@/components/views/FlowView';
import { ExplorerView } from '@/components/views/ExplorerView';
import { SettingsView } from '@/components/views/SettingsView';
import { RoadmapTimeline } from '@/components/RoadmapTimeline';
import type { ActionBucketKey } from '@/lib/types';
import './styles/dashboard.css';

function WindowPicker() {
  const { windowDays, setWindowDays, maxWindowDays } = useDashboard();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Build options up to (and including) the server's cached max window.
  const PRESETS = [7, 14, 30, 60, 90, 183, 365];
  const options = PRESETS.filter(n => n <= maxWindowDays);
  if (!options.includes(maxWindowDays)) options.push(maxWindowDays);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  return (
    <span ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 -mx-1 rounded border border-transparent hover:border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        title="Change time window"
      >
        last {windowDays} days
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute z-30 left-0 top-full mt-1 min-w-[160px] bg-card border border-border rounded-md shadow-lg p-1">
          {options.map(n => {
            const isActive = n === windowDays;
            const label = n === maxWindowDays ? `${n} days (full window)` : `${n} days`;
            return (
              <button
                key={n}
                type="button"
                onClick={() => { setWindowDays(n); setOpen(false); }}
                className={'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left ' + (isActive ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent')}
              >
                <Check className={'h-3.5 w-3.5 ' + (isActive ? 'opacity-100' : 'opacity-0')} />
                {label}
              </button>
            );
          })}
          <div className="px-2 py-1 mt-1 border-t border-border text-[10.5px] text-muted-foreground">
            Server cache: {maxWindowDays} days
          </div>
        </div>
      )}
    </span>
  );
}

function Subhead() {
  const { data, currentProject, status, errorMsg } = useDashboard();
  if (status === 'error') {
    return <p className="text-sm text-red-600 dark:text-red-400">Error: {errorMsg}</p>;
  }
  if (status === 'loading' || !data) {
    return <p className="text-sm text-muted-foreground">Loading from local server…</p>;
  }
  return (
    <h2 className="text-xl font-semibold tracking-tight mt-1 mb-2">
      {currentProject?.name || 'Workspace data'}
      <span className="ml-3 text-sm font-normal text-muted-foreground">
        <WindowPicker />
        <span className="mx-1.5">·</span>
        {data.kpi.total} work items
      </span>
    </h2>
  );
}

function Footer() {
  const { data } = useDashboard();
  if (!data) return null;
  const meta = data._meta || {};
  return (
    <footer className="text-xs text-muted-foreground py-4 mt-6 border-t border-border">
      Local refresh server · workspace <strong className="text-foreground">{meta.workspace_slug || '?'}</strong>
      {' '}· project <strong className="text-foreground">{(meta.project_id || '').slice(0, 8)}</strong>
      {' '}· {meta.item_count || 0} items · refreshed {meta.last_refreshed_at || 'never'}
    </footer>
  );
}

// "/" lands on the last tab the user visited (persisted), defaulting to Pulse.
function lastVisitedTab(): TabKey {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.tab);
    if (v && keyForSegment(segmentForKey(v as TabKey)) === v) return v as TabKey;
  } catch { /* ignore */ }
  return DEFAULT_TAB;
}

// Empty state when the user hasn't added any workspace yet.
function AddWorkspacePrompt() {
  const { addWorkspace } = useDashboard();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await addWorkspace(url.trim()); }
    catch (e) { setErr((e as Error).message || 'Could not add workspace'); setBusy(false); }
  };
  return (
    <div className="max-w-md mx-auto mt-16 text-center">
      <h2 className="text-lg font-semibold mb-1">Add a workspace</h2>
      <p className="text-sm text-muted-foreground mb-4">Paste the URL of a Plane workspace you belong to.</p>
      <div className="flex gap-2">
        <input
          type="text" value={url} autoFocus
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="app.plane.so/your-workspace"
          className="flex-1 px-3 py-2 text-sm rounded-md border border-border bg-card outline-none focus:border-ring"
        />
        <button type="button" onClick={submit} disabled={busy || !url.trim()}
          className="px-3 py-2 text-sm rounded-md bg-foreground text-background disabled:opacity-50">
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      {err && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</div>}
    </div>
  );
}

// "/" → most-recent workspace's last tab, or the add-workspace prompt if none.
function HomeRedirect({ workspaces }: { workspaces: string[] | null }) {
  if (workspaces === null) return null;       // remembered list not loaded yet
  if (!workspaces.length) return <AddWorkspacePrompt />;
  return <Navigate to={tabUrl(workspaces[0], lastVisitedTab())} replace />;
}

// "/:ws" (no tab) → that workspace's last tab (if remembered), else home.
function WsIndex({ workspaces }: { workspaces: string[] | null }) {
  const { ws } = useParams();
  if (workspaces === null) return null;
  if (ws && workspaces.includes(ws)) return <Navigate to={tabUrl(ws, lastVisitedTab())} replace />;
  return <HomeRedirect workspaces={workspaces} />;
}

// Resolves /:ws/:tab. The URL's workspace must be one the user has added; if not,
// fall back to the most-recent workspace (or the add prompt). Unknown tab → default.
function TabResolver({ workspaces, viewFor }: {
  workspaces: string[] | null;
  viewFor: (key: TabKey) => ReactNode;
}) {
  const { ws, tab } = useParams();
  if (workspaces === null) return null; // remembered list not loaded yet
  if (!ws || !workspaces.includes(ws)) {
    if (!workspaces.length) return <AddWorkspacePrompt />;
    const key = (tab && keyForSegment(tab)) || DEFAULT_TAB;
    return <Navigate to={tabUrl(workspaces[0], key)} replace />;
  }
  const key = tab ? keyForSegment(tab) : undefined;
  if (!key) return <Navigate to={tabUrl(ws, lastVisitedTab())} replace />;
  return <>{viewFor(key)}</>;
}

function Inner() {
  const { data, workspaces, workspaceSlug } = useDashboard();
  const navigate = useNavigate();
  const location = useLocation();
  const [jumpKey, setJumpKey] = useState<ActionBucketKey | null>(null);

  // Remember the active tab (2nd path segment) so a later visit to "/" reopens it.
  useEffect(() => {
    const seg = location.pathname.split('/').filter(Boolean)[1];
    const key = seg ? keyForSegment(seg) : undefined;
    if (key) { try { localStorage.setItem(STORAGE_KEYS.tab, key); } catch { /* ignore */ } }
  }, [location.pathname]);

  const onJump = (k: ActionBucketKey) => {
    if (workspaceSlug) navigate(tabUrl(workspaceSlug, 'action'));
    setJumpKey(k);
    setTimeout(() => {
      const el = document.getElementById('bucket-' + k);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  };

  const viewFor = (key: TabKey): ReactNode => {
    if (!data) return null;
    switch (key) {
      case 'pulse':    return <PulseView onJump={onJump} />;
      case 'roadmap':  return <RoadmapTimeline />;
      case 'mywork':   return <MyWorkView onJump={onJump} />;
      case 'action':   return <ActionCenterView jumpKey={jumpKey} />;
      case 'due':      return <DueWorkView />;
      case 'capacity': return <CapacityView />;
      case 'flow':     return <FlowView />;
      case 'explorer': return <ExplorerView />;
    }
  };

  const isSettings = location.pathname.split('/').filter(Boolean)[1] === 'settings';

  return (
    <main className="max-w-[1400px] mx-auto px-6">
      <Topbar />
      {!isSettings && <Subhead />}
      {!isSettings && <Tabs />}
      <div className="py-4">
        <Routes>
          <Route path="/" element={<HomeRedirect workspaces={workspaces} />} />
          <Route path="/:ws/settings" element={<SettingsView />} />
          <Route path="/:ws" element={<WsIndex workspaces={workspaces} />} />
          <Route path="/:ws/:tab" element={<TabResolver workspaces={workspaces} viewFor={viewFor} />} />
          <Route path="*" element={<HomeRedirect workspaces={workspaces} />} />
        </Routes>
      </div>
      <Footer />
    </main>
  );
}

export default function App() {
  return (
    <DashboardProvider>
      <Inner />
    </DashboardProvider>
  );
}
