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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, X, Send, Plus, Check } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { api } from '@/lib/api';
import type { Priority, WorkItem, WorkItemComment } from '@/lib/types';

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

export function EditModal({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const { currentProjectId, workspaceSlug, refresh, data } = useDashboard();
  const [priority, setPriority] = useState<Priority>(item.priority);
  const [start, setStart] = useState(item.start || '');
  const [end, setEnd] = useState(item.end || '');
  const initialAssignees = useMemo<string[]>(() => {
    if (item.assignee_ids && item.assignee_ids.length) return [...item.assignee_ids];
    return item.assignee_id ? [item.assignee_id] : [];
  }, [item.assignee_ids, item.assignee_id]);
  const [assignees, setAssignees] = useState<string[]>(initialAssignees);

  const statesList = data?.states_list || [];
  const initialStateId = useMemo(
    () => statesList.find(s => s.name === item.state)?.id || '',
    [statesList, item.state],
  );
  const [stateId, setStateId] = useState<string>(initialStateId);
  useEffect(() => { setStateId(initialStateId); }, [initialStateId]);

  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const initialDescription = item.description_stripped || '';
  const [description, setDescription] = useState(initialDescription);
  useEffect(() => { setDescription(item.description_stripped || ''); }, [item.description_stripped]);

  const [comments, setComments] = useState<WorkItemComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsErr, setCommentsErr] = useState<string | null>(null);

  const users = data?.users || {};
  const userColors = data?.user_colors || {};

  const fetchComments = useCallback(async () => {
    if (!currentProjectId) return;
    setCommentsLoading(true);
    setCommentsErr(null);
    try {
      const list = await api.listComments(workspaceSlug!, currentProjectId, item.id);
      list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      setComments(list);
    } catch (e) {
      setCommentsErr((e as Error).message);
    } finally {
      setCommentsLoading(false);
    }
  }, [currentProjectId, item.id]);

  useEffect(() => { fetchComments(); }, [fetchComments]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const assigneesDirty = useMemo(() => {
    if (assignees.length !== initialAssignees.length) return true;
    const a = new Set(assignees);
    return initialAssignees.some(id => !a.has(id));
  }, [assignees, initialAssignees]);

  const stateDirty = !!stateId && stateId !== initialStateId;
  const descriptionDirty = description !== initialDescription;

  const dirty =
    priority !== item.priority ||
    start !== (item.start || '') ||
    end !== (item.end || '') ||
    assigneesDirty ||
    stateDirty ||
    descriptionDirty;

  const handleSave = async () => {
    if (!currentProjectId || !dirty) return;
    const patch: Record<string, unknown> = {};
    if (priority !== item.priority) patch.priority = priority;
    if (start !== (item.start || '')) patch.start_date = start || null;
    if (end !== (item.end || '')) patch.target_date = end || null;
    if (assigneesDirty) patch.assignee_ids = assignees;
    if (stateDirty) patch.state = stateId;
    if (descriptionDirty) {
      patch.description_html = description.trim() ? commentToHtml(description) : '<p></p>';
    }
    setSaving(true);
    setMsg(null);
    try {
      await api.patchWorkItem(workspaceSlug!, currentProjectId, item.id, patch);
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
      await api.addComment(workspaceSlug!, currentProjectId, item.id, html);
      setMsg({ kind: 'ok', text: 'Comment posted.' });
      setComment('');
      fetchComments();
    } catch (e) {
      setMsg({ kind: 'err', text: 'Comment failed: ' + (e as Error).message });
    } finally {
      setPosting(false);
    }
  };

  const commentAuthor = (c: WorkItemComment): string => {
    const d = c.actor_detail || c.created_by_detail;
    if (d) {
      const name = d.display_name || [d.first_name, d.last_name].filter(Boolean).join(' ').trim();
      if (name) return name;
    }
    const uid = c.actor || c.created_by;
    return (uid && users[uid]) || 'Unknown';
  };
  const commentColor = (c: WorkItemComment): string => {
    const uid = (c.actor_detail || c.created_by_detail)?.id || c.actor || c.created_by || '';
    return (uid && userColors[uid]) || '#888780';
  };
  const fmtCommentDate = (iso?: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[94vw] max-h-[90vh] bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col"
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

        <div className="px-4 py-4 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">State</label>
              {statesList.length === 0 ? (
                <div className="text-xs text-muted-foreground py-1.5">{item.state}</div>
              ) : (
                <select
                  value={stateId}
                  onChange={(e) => setStateId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm outline-none focus:ring-2 focus:ring-ring/30"
                >
                  {statesList.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm outline-none focus:ring-2 focus:ring-ring/30"
              >
                {PRIORITIES.map(p => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={item.description_html ? 'Edit description…' : 'Add a description…'}
                rows={4}
                className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-[13px] leading-snug outline-none focus:ring-2 focus:ring-ring/30 resize-y min-h-[80px]"
              />
              {item.description_html && !descriptionDirty && (
                <details className="mt-1">
                  <summary className="text-[10.5px] text-muted-foreground cursor-pointer select-none">Show original formatting</summary>
                  <div
                    className="comment-html mt-1 px-2 py-1.5 rounded-md border border-border bg-background/40 text-[12.5px] leading-snug"
                    dangerouslySetInnerHTML={{ __html: item.description_html }}
                  />
                </details>
              )}
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Assignees</label>
              <AssigneePicker
                users={users}
                userColors={userColors}
                selected={assignees}
                onChange={setAssignees}
              />
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
          <div className="flex items-center justify-between">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Comments {comments.length > 0 && <span className="text-foreground/70">({comments.length})</span>}</label>
            {commentsLoading && <span className="text-[10.5px] text-muted-foreground">loading…</span>}
          </div>
          {commentsErr && <div className="text-[11px] text-red-700 dark:text-red-400">Couldn't load comments: {commentsErr}</div>}
          {!commentsLoading && !commentsErr && comments.length === 0 && (
            <div className="text-[11.5px] text-muted-foreground italic">No comments yet.</div>
          )}
          {comments.length > 0 && (
            <ul className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
              {comments.map(c => (
                <li key={c.id} className="rounded-md border border-border bg-background/40 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span
                      className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold text-white flex-shrink-0"
                      style={{ background: commentColor(c) }}
                    >
                      {initials(commentAuthor(c))}
                    </span>
                    <span className="text-[11.5px] font-medium truncate">{commentAuthor(c)}</span>
                    <span className="text-[10.5px] text-muted-foreground">· {fmtCommentDate(c.updated_at || c.created_at)}</span>
                  </div>
                  {c.comment_html ? (
                    <div className="comment-html text-[12.5px] leading-snug" dangerouslySetInnerHTML={{ __html: c.comment_html }} />
                  ) : (
                    <div className="text-[12.5px] leading-snug whitespace-pre-wrap">{c.comment_stripped || ''}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join('').toUpperCase() || '?';
}

function AssigneePicker({
  users,
  userColors,
  selected,
  onChange,
}: {
  users: Record<string, string>;
  userColors: Record<string, string>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
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

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allOptions = useMemo(
    () => Object.entries(users)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allOptions.filter(o => o.name.toLowerCase().includes(q)) : allOptions;
  }, [allOptions, query]);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selected.filter(x => x !== id));
    else onChange([...selected, id]);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex flex-wrap gap-1.5 items-center">
        {selected.map(id => {
          const name = users[id] || `User ${id.slice(0, 6)}`;
          const color = userColors[id] || '#888780';
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full border border-border bg-card text-[11.5px]"
            >
              <span
                className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold text-white"
                style={{ background: color }}
              >
                {initials(name)}
              </span>
              <span className="truncate max-w-[140px]">{name}</span>
              <button
                type="button"
                onClick={() => toggle(id)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-border text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <Plus className="h-3 w-3" />
          {selected.length === 0 ? 'Add assignee' : 'Add'}
        </button>
      </div>

      {open && (
        <div className="absolute z-50 left-0 top-full mt-1 min-w-[240px] max-w-[320px] bg-card border border-border rounded-md shadow-lg p-1">
          {allOptions.length > 6 && (
            <input
              type="text"
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter members…"
              className="w-full px-2 py-1 mb-1 text-xs rounded border border-border bg-background outline-none focus:ring-1 focus:ring-ring/30"
            />
          )}
          <div className="max-h-[240px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No matches</div>
            ) : filtered.map(o => {
              const checked = selectedSet.has(o.id);
              const color = userColors[o.id] || '#888780';
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggle(o.id)}
                  className={'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-accent ' +
                    (checked ? 'text-foreground' : 'text-muted-foreground')}
                >
                  <Check className={'h-3.5 w-3.5 flex-shrink-0 ' + (checked ? 'opacity-100' : 'opacity-0')} />
                  <span
                    className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold text-white flex-shrink-0"
                    style={{ background: color }}
                  >
                    {initials(o.name)}
                  </span>
                  <span className="flex-1 truncate" title={o.name}>{o.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
