import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, RefreshCw, Download, LogOut, Settings, User } from 'lucide-react';
import { WorkspacePicker } from './WorkspacePicker';
import { ProjectPicker } from './ProjectPicker';
import { ThemeToggle } from './ThemeToggle';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';

export function Topbar() {
  const { status, refresh, refreshing, data, workspaceSlug, workspaces } = useDashboard();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const fetching = status === 'fetching';
  const lastIso = data?._meta?.last_refreshed_at;
  const fullDate = lastIso
    ? `Last refreshed ${new Date(lastIso).toLocaleString()}`
    : 'No refresh yet';

  const [email, setEmail] = useState<string | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);

  useEffect(() => {
    api.me()
      .then((r) => { setEmail(r.email); setAuthEnabled(r.auth_enabled); })
      .catch(() => { /* unauthenticated requests redirect at server */ });
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const settingsWs = workspaceSlug || workspaces?.[0] || '';
  const openSettings = () => {
    setMenuOpen(false);
    if (settingsWs) navigate(`/${settingsWs}/settings`);
  };

  function logout() {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/auth/logout';
    document.body.appendChild(form);
    form.submit();
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <span className="flex items-center gap-2 text-sm">
        <a href="https://plane.so" target="_blank" rel="noopener" className="brand-mark" title="plane.so">
          <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#3F76FF" />
            <path d="M10 8.5L20 16L10 23.5V8.5Z" fill="white" />
            <circle cx="23" cy="14.5" r="3" fill="white" fillOpacity="0.9" />
          </svg>
          <span className="brand-text">Plane</span>
        </a>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <WorkspacePicker />
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <ProjectPicker />
      </span>

      <span className="flex items-center ml-auto">
        <span className={'live-pill' + (fetching ? ' fetching' : '')} title={fullDate}>
          {fetching ? 'Fetching' : 'Live'}
        </span>
      </span>

      <ThemeToggle />

      <button
        type="button"
        className="inline-flex items-center gap-2 px-3 h-8 rounded-md border border-border bg-card text-sm hover:bg-accent transition-colors disabled:opacity-60"
        onClick={refresh}
        disabled={refreshing || !data}
      >
        <RefreshCw className={'h-3.5 w-3.5' + (refreshing ? ' animate-spin' : '')} />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>

      <button
        type="button"
        className="inline-flex items-center gap-2 px-3 h-8 rounded-md border border-border bg-card text-sm hover:bg-accent transition-colors"
        onClick={() => window.print()}
      >
        <Download className="h-3.5 w-3.5" />
        Export
      </button>

      <div ref={menuRef} className="relative pl-2 ml-1 border-l border-border">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
          className="inline-flex items-center justify-center h-8 w-8 rounded-full border border-border bg-card text-sm font-medium hover:bg-accent transition-colors"
          title={email || 'Account'}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {email ? email[0].toUpperCase() : <User className="h-4 w-4" />}
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1.5 min-w-[200px] z-40 bg-card border border-border rounded-md shadow-lg p-1" role="menu">
            {email && (
              <div className="px-2.5 py-2 border-b border-border mb-1">
                <div className="text-xs text-muted-foreground">Signed in as</div>
                <div className="text-sm truncate" title={email}>{email}</div>
              </div>
            )}
            <button
              type="button"
              onClick={openSettings}
              disabled={!settingsWs}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-sm text-left text-foreground hover:bg-accent disabled:opacity-50"
              role="menuitem"
            >
              <Settings className="h-4 w-4" /> Settings
            </button>
            {authEnabled && email && (
              <button
                type="button"
                onClick={() => { setMenuOpen(false); logout(); }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-sm text-left text-foreground hover:bg-accent"
                role="menuitem"
              >
                <LogOut className="h-4 w-4" /> Logout
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
