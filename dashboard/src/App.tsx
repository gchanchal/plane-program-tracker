import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { DashboardProvider, useDashboard } from '@/lib/dashboard-context';
import { useTab } from '@/lib/use-tab';
import { Topbar } from '@/components/Topbar';
import { Tabs } from '@/components/Tabs';
import { PulseView } from '@/components/views/PulseView';
import { MyWorkView } from '@/components/views/MyWorkView';
import { ActionCenterView } from '@/components/views/ActionCenterView';
import { DueWorkView } from '@/components/views/DueWorkView';
import { CapacityView } from '@/components/views/CapacityView';
import { FlowView } from '@/components/views/FlowView';
import { ExplorerView } from '@/components/views/ExplorerView';
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

function Inner() {
  const { tab, setTab } = useTab();
  const { data } = useDashboard();
  const [jumpKey, setJumpKey] = useState<ActionBucketKey | null>(null);

  const onJump = (k: ActionBucketKey) => {
    setTab('action');
    setJumpKey(k);
    setTimeout(() => {
      const el = document.getElementById('bucket-' + k);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  return (
    <main className="max-w-[1400px] mx-auto px-6">
      <Topbar />
      <Subhead />
      <Tabs tab={tab} setTab={setTab} />
      <div className="py-4">
        {data && tab === 'pulse'    && <PulseView onJump={onJump} />}
        {data && tab === 'roadmap'  && <RoadmapTimeline />}
        {data && tab === 'mywork'   && <MyWorkView onJump={onJump} />}
        {data && tab === 'action'   && <ActionCenterView jumpKey={jumpKey} />}
        {data && tab === 'due'      && <DueWorkView />}
        {data && tab === 'capacity' && <CapacityView />}
        {data && tab === 'flow'     && <FlowView />}
        {data && tab === 'explorer' && <ExplorerView />}
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
