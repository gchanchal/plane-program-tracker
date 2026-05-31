import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, X } from 'lucide-react';

export interface MultiSelectOption {
  /** Stable identifier used as the filter value. */
  value: string;
  /** Label shown to the user. */
  label: string;
  /** Optional swatch color (for state / priority / label chips). */
  color?: string;
  /** Optional count shown beside the label. */
  count?: number;
}

interface Props {
  /** Short noun shown on the chip when no selection is active, e.g. "Priority". */
  label: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** If true, hide the chip entirely when there are no options. */
  hideWhenEmpty?: boolean;
}

export function MultiSelectChip({ label, options, selected, onChange, hideWhenEmpty }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (hideWhenEmpty && options.length === 0) return null;

  const filtered = query
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const activeCount = selected.size;
  const active = activeCount > 0;

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(new Set());
  };

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={
          'inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full border text-xs whitespace-nowrap transition-colors ' +
          (active
            ? 'border-ring bg-accent text-foreground'
            : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent')
        }
      >
        <span>{label}</span>
        {active && (
          <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-foreground text-background text-[10px] font-semibold">
            {activeCount}
          </span>
        )}
        {active ? (
          <span onClick={clear} className="hover:text-foreground" aria-label="Clear">
            <X className="h-3 w-3" />
          </span>
        ) : (
          <ChevronDown className="h-3 w-3 opacity-70" />
        )}
      </button>
      {open && (
        <div className="absolute z-200 left-0 top-full mt-1 min-w-[220px] max-w-[300px] bg-card border border-border rounded-md shadow-lg p-1" style={{ zIndex: 200 }}>
          {options.length > 8 && (
            <input
              type="text"
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Filter ${label.toLowerCase()}…`}
              className="w-full px-2 py-1 mb-1 text-xs rounded border border-border bg-background outline-none focus:ring-1 focus:ring-ring/30"
            />
          )}
          <div className="max-h-[260px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No matches</div>
            ) : filtered.map(o => {
              const checked = selected.has(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-accent ' +
                    (checked ? 'text-foreground' : 'text-muted-foreground')}
                >
                  <Check className={'h-3.5 w-3.5 flex-shrink-0 ' + (checked ? 'opacity-100' : 'opacity-0')} />
                  {o.color && (
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: o.color }} />
                  )}
                  <span className="flex-1 truncate" title={o.label}>{o.label}</span>
                  {typeof o.count === 'number' && (
                    <span className="text-[10.5px] text-muted-foreground">{o.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
