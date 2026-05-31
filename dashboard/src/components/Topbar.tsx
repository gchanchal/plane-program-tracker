import { useEffect, useState } from 'react';
import { ChevronRight, RefreshCw, Download, LogOut } from 'lucide-react';
import { ProjectPicker } from './ProjectPicker';
import { ThemeToggle } from './ThemeToggle';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';

export function Topbar() {
  const { status, refresh, refreshing, data } = useDashboard();
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

      {authEnabled && email && (
        <span className="flex items-center gap-2 pl-3 ml-1 border-l border-border">
          <span className="text-xs text-muted-foreground hidden md:inline" title={email}>{email}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md border border-border bg-card text-sm hover:bg-accent transition-colors"
            onClick={logout}
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="sr-only md:not-sr-only">Logout</span>
          </button>
        </span>
      )}
    </div>
  );
}
