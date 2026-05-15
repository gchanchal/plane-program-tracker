import { useEffect, useRef, useState } from 'react';
import { Search, Check, ChevronDown } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';

export function ProjectPicker() {
  const { projects, currentProject, currentProjectId, setCurrentProjectId } = useDashboard();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const filtered = query
    ? projects.filter(p =>
        (p.name || '').toLowerCase().includes(query.toLowerCase()) ||
        (p.identifier || '').toLowerCase().includes(query.toLowerCase()))
    : projects;

  const triggerLabel = !projects.length
    ? 'No projects'
    : currentProject?.identifier
      ? `${currentProject.identifier} · ${currentProject.name || ''}`
      : currentProject?.name || 'Select project…';

  return (
    <div ref={wrapRef} className={'project-picker' + (open ? ' open' : '')}>
      <button
        type="button"
        className="project-trigger"
        disabled={!projects.length}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
      >
        <span>{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <div className="project-panel">
        <div className="project-search-wrap">
          <Search className="h-3.5 w-3.5" />
          <input
            ref={inputRef}
            className="project-search"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); return; }
              if (!filtered.length) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx(i => (i + 1) % filtered.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx(i => (i - 1 + filtered.length) % filtered.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const pick = filtered[activeIdx] || filtered[0];
                if (pick) {
                  setCurrentProjectId(pick.id);
                  setOpen(false);
                }
              }
            }}
          />
        </div>
        <div className="project-list">
          {filtered.length === 0 ? (
            <div className="project-empty">No matches</div>
          ) : filtered.map((p, idx) => (
            <div
              key={p.id}
              className={
                'project-item' +
                (p.id === currentProjectId ? ' selected' : '') +
                (idx === activeIdx ? ' active' : '')
              }
              onClick={() => { setCurrentProjectId(p.id); setOpen(false); }}
            >
              {p.identifier && <span className="ident">{p.identifier}</span>}
              <span className="name">{p.name || p.id}</span>
              {p.id === currentProjectId && <Check className="check h-3.5 w-3.5" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
