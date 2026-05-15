/**
 * Reusable trigger button + modal for editing a Plane work item from any
 * card / row in the dashboard. Modal supports:
 *   - Updating priority (urgent/high/medium/low/none)
 *   - Updating start_date and target_date (date inputs; clearable)
 *   - Adding a comment (POST /api/work-item-comment → Plane)
 *
 * After a successful save we trigger a full project refresh via the dashboard
 * context so all views reflect the change. Comments don't refresh the cache
 * because they don't affect any of the cached aggregates.
 */
import { useEffect, useState } from 'react';
import { Pencil, X, Send } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';
import type { Priority, WorkItem } from '@/lib/types';

interface Props {
  item: WorkItem;
  /** Visual variant: "icon" (small pencil, default) or "chip" (text label). */
  variant?: 'icon' | 'chip';
  /** Extra class for the trigger. */
  className?: string;
}

const PRIORITIES: Array<{ key: Priority; label: string; color: string }> = [
  { key: 'urgent', label: 'Urgent', color: '#A32D2D' },
  { key: 'high',   label: 'High',   color: '#EF9F27' },
  { key: 'medium', label: 'Medium', color: '#378ADD' },
  { key: 'low',    label: 'Low',    color: '#888780' },
  { key: 'none',   label: 'None',   color: '#B8B4A8' },
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function commentToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

export function EditWorkItem({ item, variant = 'icon', className }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = variant === 'icon' ? (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      className={'inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ' + (className || '')}
      title="Edit"
    >
      <Pencil className="h-3.5 w-3.5" />
    </button>
  ) : (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      className={'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border border-border bg-card hover:bg-accent transition-colors ' + (className || '')}
    >
      <Pencil className="h-3 w-3" />Edit
    </button>
  );

  return (
    <>
      {trigger}
      {open && <EditModal item={item} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditModal({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const { currentProjectId, refresh } = useDashboard();
  const [priority, setPriority] = useState<Priority>(item.priority);
  const [start, setStart] = useState(item.start || '');
  const [end, setEnd] = useState(item.end || '');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const dirty = priority !== item.priority || start !== (item.start || '') || end !== (item.end || '');

  const handleSave = async () => {
    if (!currentProjectId || !dirty) return;
    const patch: Record<string, unknown> = {};
    if (priority !== item.priority) patch.priority = priority;
    if (start !== (item.start || '')) patch.start_date = start || null;
    if (end !== (item.end || '')) patch.target_date = end || null;
    setSaving(true);
    setMsg(null);
    try {
      await api.patchWorkItem(currentProjectId, item.id, patch);
      setMsg({ kind: 'ok', text: 'Saved. Refreshing…' });
      await refresh();
      onClose();
    } catch (e) {
      setMsg({ kind: 'err', text: 'Save failed: ' + (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleComment = async () => {
    if (!currentProjectId || !comment.trim()) return;
    const html = commentToHtml(comment);
    if (!html) return;
    setPosting(true);
    setMsg(null);
    try {
      await api.addComment(currentProjectId, item.id, html);
      setMsg({ kind: 'ok', text: 'Comment posted.' });
      setComment('');
    } catch (e) {
      setMsg({ kind: 'err', text: 'Comment failed: ' + (e as Error).message });
    } finally {
      setPosting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[94vw] bg-card border border-border rounded-lg shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Edit</div>
            <div className="text-sm font-medium truncate">{item.name}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Priority</label>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITIES.map(p => {
                  const active = priority === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setPriority(p.key)}
                      className={'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] border transition-colors ' + (active ? 'border-foreground/40 bg-accent' : 'border-border bg-card hover:bg-accent')}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Start date</label>
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Due date</label>
                <input
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="px-3 py-1.5 rounded-md bg-foreground text-background text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {dirty && !saving && <span className="text-[11px] text-muted-foreground">unsaved changes</span>}
          </div>
        </div>

        <div className="px-4 py-4 border-t border-border space-y-2">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground block">Add a comment</label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What's the update?"
            rows={3}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm outline-none focus:ring-2 focus:ring-ring/30 resize-y min-h-[60px]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleComment}
              disabled={!comment.trim() || posting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send className="h-3.5 w-3.5" />
              {posting ? 'Posting…' : 'Post comment'}
            </button>
            <span className="text-[11px] text-muted-foreground">posts to Plane as you</span>
          </div>
        </div>

        {msg && (
          <div className={'px-4 py-2 text-[11.5px] border-t border-border ' + (msg.kind === 'ok' ? 'text-green-700 dark:text-green-400 bg-green-500/5' : 'text-red-700 dark:text-red-400 bg-red-500/5')}>
            {msg.text}
          </div>
        )}
      </div>
    </>
  );
}
