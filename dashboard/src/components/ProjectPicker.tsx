import { useEffect, useRef, useState } from 'react';
import { Search, Check, ChevronDown } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';

export function ProjectPicker() {
  const { projects, currentProject, selectedProjectIds, setSelectedProjectIds } = useDashboard();
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

  const matched = query
    ? projects.filter(p =>
        (p.name || '').toLowerCase().includes(query.toLowerCase()) ||
        (p.identifier || '').toLowerCase().includes(query.toLowerCase()))
    : projects;
  const selectedSet = new Set(selectedProjectIds);
  // Selected projects sort to the top; stable within each group (project order).
  const filtered = [...matched].sort((a, b) => (selectedSet.has(a.id) ? 0 : 1) - (selectedSet.has(b.id) ? 0 : 1));
  const allSelected = projects.length > 0 && selectedProjectIds.length === projects.length;

  // Toggle one project; always keep at least one selected. Preserve project order.
  const toggle = (id: string) => {
    const next = new Set(selectedSet);
    if (next.has(id)) {
      if (next.size > 1) next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedProjectIds(projects.filter(p => next.has(p.id)).map(p => p.id));
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedProjectIds([currentProject?.id || projects[0]?.id].filter(Boolean) as string[]);
    } else {
      setSelectedProjectIds(projects.map(p => p.id));
    }
  };

  const triggerLabel = !projects.length
    ? 'No projects'
    : selectedProjectIds.length > 1
      ? `${selectedProjectIds.length} projects`
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
                if (pick) toggle(pick.id);
              }
            }}
          />
        </div>
        {!query && projects.length > 1 && (
          <div
            className={'project-item' + (allSelected ? ' selected' : '')}
            onClick={toggleAll}
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="name" style={{ fontWeight: 600 }}>
              {allSelected ? 'Clear to one project' : 'All projects'}
            </span>
            {allSelected && <Check className="check h-3.5 w-3.5" />}
          </div>
        )}
        <div className="project-list">
          {filtered.length === 0 ? (
            <div className="project-empty">No matches</div>
          ) : filtered.map((p, idx) => {
            const checked = selectedSet.has(p.id);
            return (
              <div
                key={p.id}
                className={
                  'project-item' +
                  (checked ? ' selected' : '') +
                  (idx === activeIdx ? ' active' : '')
                }
                onClick={() => toggle(p.id)}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    border: '1.5px solid ' + (checked ? 'var(--foreground)' : 'var(--border)'),
                    background: checked ? 'var(--foreground)' : 'transparent',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {checked && <Check className="h-3 w-3" style={{ color: 'var(--background)' }} />}
                </span>
                {p.identifier && <span className="ident">{p.identifier}</span>}
                <span className="name">{p.name || p.id}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
