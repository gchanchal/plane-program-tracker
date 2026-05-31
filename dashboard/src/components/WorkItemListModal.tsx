import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { PRIORITY_INFO } from '@/lib/constants';
import { planeItemUrl, prioCls, projectPrefix } from '@/lib/format';
import { EditWorkItem } from './EditWorkItem';
import type { DataMeta, ProjectSummary, WorkItem } from '@/lib/types';

interface ItemWithMetric extends WorkItem {
  _metricStr?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  items: ItemWithMetric[];
  currentProject: ProjectSummary | null;
  meta?: DataMeta;
}

export function WorkItemListModal({ open, onClose, title, subtitle, items, currentProject, meta }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const projIdent = projectPrefix(currentProject);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[860px] max-w-[94vw] max-h-[80vh] bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col"
      >
        <header className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <h3 className="font-medium text-sm truncate">{title}</h3>
            <p className="text-xs text-muted-foreground">
              {items.length} item{items.length === 1 ? '' : 's'}
              {subtitle ? ` · ${subtitle}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="action-empty">Nothing here.</div>
          ) : (
            items.map(item => {
              const prio = PRIORITY_INFO[item.priority] || PRIORITY_INFO.none;
              const url = planeItemUrl(item.seq, { id: '', identifier: projIdent } as ProjectSummary, meta);
              return (
                <div
                  key={item.id}
                  className="grid items-center gap-3 px-4 py-2 border-b border-border last:border-0 text-[12.5px]"
                  style={{ gridTemplateColumns: '90px 1fr auto auto auto auto auto' }}
                >
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener"
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    onClick={e => e.stopPropagation()}
                  >
                    {projIdent}-{item.seq}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <span className="truncate" title={item.name}>{item.name}</span>
                  <span className={'badge ' + prioCls(item.priority)}>{prio.label}</span>
                  <span className="text-muted-foreground text-[11px]">{item.state}</span>
                  <span className="text-muted-foreground text-[11px] max-w-[140px] truncate" title={item.assignee || 'unassigned'}>
                    {item.assignee || 'unassigned'}
                  </span>
                  {item._metricStr ? (
                    <span className="text-muted-foreground text-[11px] whitespace-nowrap">{item._metricStr}</span>
                  ) : <span />}
                  <EditWorkItem item={item} />
                </div>
              );
            })
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
