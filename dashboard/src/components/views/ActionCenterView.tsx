import { useMemo, useState } from 'react';
import { ChevronRight, Wrench, ArrowUp, ArrowDown, ArrowUpDown, Search, X } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { PRIORITY_INFO, PRIORITY_RANK } from '@/lib/constants';
import { api } from '@/lib/api';
import { countSeverity, planeItemUrl, prioCls, projectPrefix } from '@/lib/format';
import { useResizableCols } from '@/lib/use-resizable-cols';
import { EditWorkItem } from '@/components/EditWorkItem';
import { DueChangesPill } from '@/components/DueChangesPill';
import type { ActionBucketKey, ActionItem } from '@/lib/types';

type SortCol = 'priority' | 'seq' | 'name' | 'assignee' | 'metric';
type SortDir = 'asc' | 'desc';

const METRIC_LABEL: Record<ActionBucketKey, string> = {
  past_due:          'Days late',
  aging_wip:         'Days in WIP',
  stale:             'Days idle',
  unassigned_urgent: 'Priority',
  missing_dates:     'Gaps',
};

const ORDER: ActionBucketKey[] = ['past_due', 'aging_wip', 'stale', 'unassigned_urgent', 'missing_dates'];
const SEV: Record<ActionBucketKey, [number, number]> = {
  past_due:          [1,  5],
  aging_wip:         [3, 10],
  stale:             [5, 15],
  unassigned_urgent: [1,  3],
  missing_dates:     [5, 15],
};
const FIX_SUGGESTIONS: Record<ActionBucketKey, string> = {
  past_due:          'Set a realistic target date. If the work is genuinely complete, change the state to Done instead.',
  aging_wip:         'Long WIP usually means blocked. Either move it forward (In Review / Done) or back to a holding state.',
  stale:             'Touch the item. Change state to reflect reality — if it’s no longer being worked, move it back to backlog or close it.',
  unassigned_urgent: 'Pick an owner who can pick this up this week. Urgent/high work without an assignee is the most common silent slip.',
  missing_dates:     'Add at least a target date so the item shows up in capacity/roadmap views.',
};

const isNameless = (n: string) => !n || /^User [0-9a-f]{8}$/i.test(n);

interface FixState {
  bucket: ActionBucketKey;
  itemId: string;
  draft: Record<string, string>;
  saving: boolean;
  msg: string;
  msgKind: 'ok' | 'err' | '';
}

export function ActionCenterView({ jumpKey }: { jumpKey: ActionBucketKey | null }) {
  const { data, actions, currentProject, currentProjectId, workspaceSlug, refresh } = useDashboard();
  const [open, setOpen] = useState<Set<ActionBucketKey>>(() => new Set());
  const [fix, setFix] = useState<FixState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<Partial<Record<ActionBucketKey, { col: SortCol; dir: SortDir }>>>({});

  // Column widths shared across all 5 bucket tables. Summary is the only
  // flexible column; everything else fits its content unless the user drags.
  const cols = useResizableCols({
    order: ['priority', 'id', 'name', 'meta', 'metric'] as const,
    initial: { priority: 'auto', id: 'auto', name: '1fr', meta: 'auto', metric: 'auto' },
    tail: 'auto',
  });

  // Auto-open the bucket the user jumped to via the risk strip.
  useMemo(() => {
    if (jumpKey) setOpen(prev => new Set(prev).add(jumpKey));
  }, [jumpKey]);

  if (!data || !actions) return <div className="text-sm text-muted-foreground p-4">No data.</div>;

  const projIdent = projectPrefix(currentProject);

  const filterAndSort = (key: ActionBucketKey, items: ActionItem[]): ActionItem[] => {
    const q = searchQuery.trim().toLowerCase();
    let rows = items;
    if (q) {
      rows = rows.filter(it =>
        it.name.toLowerCase().includes(q) ||
        `${it.project_identifier || projIdent}-${it.seq}`.toLowerCase().includes(q) ||
        (it.assignee || '').toLowerCase().includes(q) ||
        (it.state || '').toLowerCase().includes(q) ||
        (it.priority || '').toLowerCase().includes(q) ||
        (it.type || '').toLowerCase().includes(q),
      );
    }
    const s = sortBy[key];
    if (s) {
      const dir = s.dir === 'asc' ? 1 : -1;
      rows = rows.slice().sort((a, b) => {
        let va: string | number = '';
        let vb: string | number = '';
        if (s.col === 'priority')      { va = PRIORITY_RANK[a.priority] ?? 0;       vb = PRIORITY_RANK[b.priority] ?? 0; }
        else if (s.col === 'seq')      { va = a.seq;                                vb = b.seq; }
        else if (s.col === 'name')     { va = a.name.toLowerCase();                 vb = b.name.toLowerCase(); }
        else if (s.col === 'assignee') { va = (a.assignee || '~').toLowerCase();    vb = (b.assignee || '~').toLowerCase(); }
        else if (s.col === 'metric')   { va = a._metric;                            vb = b._metric; }
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }
    return rows;
  };

  const cycleSort = (bucket: ActionBucketKey, col: SortCol) => {
    setSortBy(prev => {
      const cur = prev[bucket];
      if (!cur || cur.col !== col) return { ...prev, [bucket]: { col, dir: 'asc' as SortDir } };
      if (cur.dir === 'asc') return { ...prev, [bucket]: { col, dir: 'desc' as SortDir } };
      const { [bucket]: _drop, ...rest } = prev;
      return rest;
    });
  };
  const SortIcon = ({ bucket, col }: { bucket: ActionBucketKey; col: SortCol }) => {
    const s = sortBy[bucket];
    if (!s || s.col !== col) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return s.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const sortedUsers = Object.entries(data.users || {})
    .filter(([, name]) => !isNameless(name))
    .sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));

  const sortedStates = (data.states_list || []).slice().sort((a, b) => {
    const order = ['started', 'completed', 'unstarted', 'backlog', 'cancelled'];
    return order.indexOf(a.group) - order.indexOf(b.group);
  });

  const toggleBucket = (k: ActionBucketKey) => {
    setOpen(prev => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };

  const openFix = (bucket: ActionBucketKey, itemId: string) => {
    setFix({ bucket, itemId, draft: {}, saving: false, msg: '', msgKind: '' });
  };
  const closeFix = () => setFix(null);

  async function applyFix() {
    if (!fix || !currentProjectId) return;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fix.draft)) {
      if (!v) continue;
      if (k === 'assignees_single') patch.assignees = [v];
      else patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      setFix(s => s ? { ...s, msg: 'Pick a value first.', msgKind: 'err' } : s);
      return;
    }
    setFix(s => s ? { ...s, saving: true, msg: '', msgKind: '' } : s);
    try {
      await api.patchWorkItem(workspaceSlug!, currentProjectId, fix.itemId, patch);
      setFix(s => s ? { ...s, msg: 'Updated. Refreshing…', msgKind: 'ok' } : s);
      await refresh();
      setFix(null);
    } catch (e) {
      setFix(s => s ? { ...s, saving: false, msg: 'Failed: ' + (e as Error).message, msgKind: 'err' } : s);
    }
  }

  function renderControls(bucket: ActionBucketKey, item: ActionItem) {
    const set = (field: string, value: string) => {
      setFix(s => s ? { ...s, draft: { ...s.draft, [field]: value } } : s);
    };
    if (bucket === 'past_due') {
      return (
        <>
          <label>New target</label>
          <input type="date" defaultValue={item.end || ''} onChange={(e) => set('target_date', e.target.value)} />
          <button className="action-fix-save" onClick={applyFix} disabled={fix?.saving}>Save</button>
        </>
      );
    }
    if (bucket === 'missing_dates') {
      return (
        <>
          <label>Start</label>
          <input type="date" defaultValue={item.start || ''} onChange={(e) => set('start_date', e.target.value)} />
          <label>Target</label>
          <input type="date" defaultValue={item.end || ''} onChange={(e) => set('target_date', e.target.value)} />
          <button className="action-fix-save" onClick={applyFix} disabled={fix?.saving}>Save dates</button>
        </>
      );
    }
    if (bucket === 'unassigned_urgent') {
      return (
        <>
          <label>Owner</label>
          <select defaultValue="" onChange={(e) => set('assignees_single', e.target.value)}>
            <option value="">— choose —</option>
            {sortedUsers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <button className="action-fix-save" onClick={applyFix} disabled={fix?.saving}>Assign</button>
        </>
      );
    }
    if (bucket === 'aging_wip' || bucket === 'stale') {
      if (!sortedStates.length) {
        return <div className="action-fix-msg err">No states cached — refresh first.</div>;
      }
      return (
        <>
          <label>Move to state</label>
          <select defaultValue="" onChange={(e) => set('state', e.target.value)}>
            <option value="">— choose —</option>
            {sortedStates.map(s => <option key={s.id} value={s.id}>{s.name} · {s.group}</option>)}
          </select>
          <button className="action-fix-save" onClick={applyFix} disabled={fix?.saving}>Update</button>
        </>
      );
    }
    return null;
  }

  const totalAcrossBuckets = ORDER.reduce((acc, k) => acc + actions[k].items.length, 0);
  const totalAfterSearch = searchQuery.trim()
    ? ORDER.reduce((acc, k) => acc + filterAndSort(k, actions[k].items).length, 0)
    : totalAcrossBuckets;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search across all buckets…"
            className="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-border bg-card text-foreground outline-none focus:ring-2 focus:ring-ring/30"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {searchQuery.trim() && (
          <span className="text-xs text-muted-foreground">
            {totalAfterSearch} of {totalAcrossBuckets} match
          </span>
        )}
        {(searchQuery || Object.keys(sortBy).length > 0) && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setSortBy({}); }}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />Clear filters
          </button>
        )}
      </div>

      <div className="action-help">
        <strong>Heads up.</strong> Aging WIP is approximated from <em>created_at</em> (Plane doesn't expose a clean state-entry time without per-item activity calls). Stale is computed from <em>updated_at</em>, which is exact. Treat aging numbers as a directional signal.
      </div>
      <div style={{ ['--cols-template' as string]: cols.gridTemplate } as React.CSSProperties}>
      {ORDER.map(key => {
        const b = actions[key];
        const filtered = filterAndSort(key, b.items);
        const n = filtered.length;
        const totalN = b.items.length;
        const [w, bd] = SEV[key];
        const sev = countSeverity(totalN, w, bd);
        const isOpen = open.has(key);
        const isFiltered = searchQuery.trim() && n !== totalN;
        return (
          <div key={key} id={`bucket-${key}`} className={'action-bucket' + (isOpen ? ' open' : '')}>
            <div className="action-bucket-head" onClick={() => toggleBucket(key)}>
              <ChevronRight className="action-bucket-chev h-4 w-4" />
              <i className={'ti ' + b.icon + ' action-bucket-icon'} />
              <div className="action-bucket-info">
                <div className="action-bucket-title">{b.title}</div>
                <div className="action-bucket-desc">{b.desc}</div>
              </div>
              <span className={'action-bucket-count ' + sev}>
                {isFiltered ? `${n} / ${totalN}` : totalN}
              </span>
            </div>
            <div className="action-bucket-list">
              {totalN === 0 ? (
                <div className="action-empty">Nothing here — good.</div>
              ) : n === 0 ? (
                <div className="action-empty">No items in this bucket match "{searchQuery}".</div>
              ) : (
                <>
                  <div className="action-row action-row-head">
                    <button type="button" className="action-th" onClick={() => cycleSort(key, 'priority')}>Priority<SortIcon bucket={key} col="priority" />
                      <span className="col-resize" onMouseDown={cols.startDrag('priority')} onClick={(e) => e.stopPropagation()} />
                    </button>
                    <button type="button" className="action-th" onClick={() => cycleSort(key, 'seq')}>ID<SortIcon bucket={key} col="seq" />
                      <span className="col-resize" onMouseDown={cols.startDrag('id')} onClick={(e) => e.stopPropagation()} />
                    </button>
                    <button type="button" className="action-th" onClick={() => cycleSort(key, 'name')}>Summary<SortIcon bucket={key} col="name" />
                      <span className="col-resize" onMouseDown={cols.startDrag('name')} onClick={(e) => e.stopPropagation()} />
                    </button>
                    <button type="button" className="action-th" onClick={() => cycleSort(key, 'assignee')}>Assignee · State<SortIcon bucket={key} col="assignee" />
                      <span className="col-resize" onMouseDown={cols.startDrag('meta')} onClick={(e) => e.stopPropagation()} />
                    </button>
                    <button type="button" className="action-th" onClick={() => cycleSort(key, 'metric')}>{METRIC_LABEL[key]}<SortIcon bucket={key} col="metric" />
                      <span className="col-resize" onMouseDown={cols.startDrag('metric')} onClick={(e) => e.stopPropagation()} />
                    </button>
                    <span />
                  </div>
                  {filtered.slice(0, 50).map(it => {
                    const prio = PRIORITY_INFO[it.priority] || PRIORITY_INFO.none;
                    const url = planeItemUrl(it.seq, { id: '', identifier: it.project_identifier || projIdent }, data._meta);
                    const isFixOpen = fix?.bucket === key && fix?.itemId === it.id;
                    return (
                      <div key={it.id}>
                        <div className={'action-row' + (isFixOpen ? ' with-fix-open' : '')}>
                          <span className={'badge ' + prioCls(it.priority)}>{prio.label}</span>
                          <a className="action-seq" href={url} target="_blank" rel="noopener">{it.project_identifier || projIdent}-{it.seq}</a>
                          <span className="action-name"><a href={url} target="_blank" rel="noopener">{it.name}</a></span>
                          <span className="action-meta">
                            {it.assignee || <em style={{ color: 'var(--muted-foreground)' }}>unassigned</em>} · {it.state}
                          </span>
                          <span className="action-metric">{it._metricStr}</span>
                          <span className="inline-flex items-center gap-1">
                            <DueChangesPill item={it} />
                            <EditWorkItem item={it} />
                            <button className="action-fix-btn" onClick={() => isFixOpen ? closeFix() : openFix(key, it.id)}>
                              <Wrench className="h-3.5 w-3.5" />Fix
                            </button>
                          </span>
                        </div>
                        {isFixOpen && (
                          <div className="action-fix-panel open">
                            <div className="action-fix-suggestion">{FIX_SUGGESTIONS[key]}</div>
                            <div className="action-fix-controls">{renderControls(key, it)}</div>
                            {fix?.msg && <div className={'action-fix-msg ' + fix.msgKind}>{fix.msg}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {n > 50 && <div className="action-empty">+ {n - 50} more (showing top 50)</div>}
                </>
              )}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
