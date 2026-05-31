import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown, ArrowUp, ArrowDown, ArrowUpDown, Search, X } from 'lucide-react';
import { useDashboard } from '@/lib/dashboard-context';
import { FIELDS, GROUP_ORDER, PRIORITY_INFO, PRIORITY_RANK, TYPE_COLORS, type ExplorerField } from '@/lib/constants';
import { fmtShortDate, planeItemUrl, prioCls, projectPrefix, stateCls } from '@/lib/format';
import { useResizableCols } from '@/lib/use-resizable-cols';
import { EditWorkItem } from '@/components/EditWorkItem';
import type { DashboardData, Portfolio, Priority, WorkItem } from '@/lib/types';

type SortKey = 'summary' | 'assignee' | 'state' | 'priority' | 'type';
type SortDir = 'asc' | 'desc';

type Generators = { root: ExplorerField[]; child: ExplorerField[] };

function PortfolioCard({ p, projectIdent, meta }: { p: Portfolio; projectIdent: string; meta?: { workspace_slug?: string } }) {
  const bd = p.breakdown;
  const total = bd._total || 0;
  if (total === 0) return null;
  const pct = (n: number | undefined) => (100 * (n || 0) / total).toFixed(1) + '%';
  const dateStr = p.start_date ? `${fmtShortDate(p.start_date)} → ${fmtShortDate(p.target_date)}` : 'no dates';
  return (
    <div className="portfolio-card">
      <div className="pc-head">
        <h4>{p.name}</h4>
        <span className={'badge ' + prioCls(p.priority)}>{p.priority}</span>
      </div>
      <div className="pc-meta">
        <a href={planeItemUrl(p.seq, { id: '', identifier: projectIdent }, meta)} target="_blank" rel="noopener" style={{ color: 'inherit', textDecoration: 'none' }}>
          {projectIdent}-{p.seq}
        </a> · {dateStr} · {total} descendants
      </div>
      <div className="pc-progress-bar">
        {(bd.completed || 0) > 0 && <div className="pc-seg pc-seg-done"       style={{ width: pct(bd.completed) }} />}
        {(bd.started   || 0) > 0 && <div className="pc-seg pc-seg-inprogress" style={{ width: pct(bd.started) }} />}
        {(bd.unstarted || 0) > 0 && <div className="pc-seg pc-seg-unstarted"  style={{ width: pct(bd.unstarted) }} />}
        {(bd.backlog   || 0) > 0 && <div className="pc-seg pc-seg-backlog"    style={{ width: pct(bd.backlog) }} />}
        {(bd.cancelled || 0) > 0 && <div className="pc-seg pc-seg-cancelled"  style={{ width: pct(bd.cancelled) }} />}
      </div>
      <div className="pc-stats">
        <span><strong>{bd._done}</strong> done</span>
        <span><strong>{bd.started || 0}</strong> active</span>
        <span><strong>{(bd.unstarted || 0) + (bd.backlog || 0)}</strong> waiting</span>
        {p.assignee && <><span style={{ color: 'var(--muted-foreground)' }}>·</span><span>{p.assignee}</span></>}
      </div>
    </div>
  );
}

function groupLabel(field: ExplorerField, key: string, data: DashboardData): string {
  if (field === 'state_group') return data.state_group_info[key as keyof typeof data.state_group_info]?.label || key;
  if (field === 'priority')    return PRIORITY_INFO[key as Priority]?.label || key;
  return key;
}
function groupColor(field: ExplorerField, key: string, data: DashboardData): string {
  if (field === 'state_group') return data.state_group_info[key as keyof typeof data.state_group_info]?.color || '#888780';
  if (field === 'priority')    return PRIORITY_INFO[key as Priority]?.color || '#888780';
  if (field === 'type')        return TYPE_COLORS[key] || '#888780';
  if (field === 'assignee') {
    for (const uid in data.users) if (data.users[uid] === key) return data.user_colors[uid] || '#888780';
    return '#888780';
  }
  return '#1A1916';
}
function groupOrderForField(field: ExplorerField, buckets: Record<string, WorkItem[]>): string[] {
  if (GROUP_ORDER[field]) return GROUP_ORDER[field]!;
  return Object.keys(buckets).sort((a, b) => (buckets[b]?.length || 0) - (buckets[a]?.length || 0));
}

function AssigneeCell({ name, color }: { name?: string; color?: string }) {
  if (!name) return <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>unassigned</span>;
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="assignee-cell">
      <span className="avatar" style={{ background: color || '#888780' }}>{initial}</span>
      <span className="assignee-name">{name}</span>
    </div>
  );
}

interface RowsProps {
  items: WorkItem[];
  generators: ExplorerField[];
  genIdx: number;
  depth: number;
  basePath: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
  childrenOf: Record<string, WorkItem[]>;
  data: DashboardData;
  projectIdent: string;
  meta?: { workspace_slug?: string };
  /** Grouping rules applied to nested children when a leaf row expands. */
  childGenerators: ExplorerField[];
}

function Rows({
  items, generators, genIdx, depth, basePath, expanded, toggle, childrenOf, data, projectIdent, meta, childGenerators,
}: RowsProps): ReactNode {
  if (genIdx >= generators.length) {
    return items.map(it => (
      <ItemRow
        key={it.id}
        item={it}
        depth={depth}
        expanded={expanded}
        toggle={toggle}
        childrenOf={childrenOf}
        data={data}
        projectIdent={projectIdent}
        meta={meta}
        childGenerators={childGenerators}
      />
    ));
  }
  const field = generators[genIdx];
  const buckets: Record<string, WorkItem[]> = {};
  for (const it of items) {
    const v = (it as unknown as Record<string, string | undefined>)[field] || 'none';
    (buckets[v] = buckets[v] || []).push(it);
  }
  const order = groupOrderForField(field, buckets);
  const out: ReactNode[] = [];
  for (const key of order) {
    if (!buckets[key]) continue;
    const path = basePath + '/' + field + ':' + key;
    const isExpanded = expanded.has(path);
    const indent = Array.from({ length: depth }).map((_, i) => <span key={i} className="indent-guide" />);
    out.push(
      <div key={path} className="srow srow-group">
        <div className="scell">
          {indent}
          <button className="chevron" onClick={() => toggle(path)}>{isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
          <span className="group-dot" style={{ background: groupColor(field, key, data) }} />
          <span style={{ color: 'var(--muted-foreground)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 6 }}>{FIELDS[field].label}</span>
          <strong>{groupLabel(field, key, data)}</strong>
          <span className="group-count">{buckets[key].length}</span>
        </div>
      </div>
    );
    if (isExpanded) {
      out.push(
        <Rows
          key={path + ':children'}
          items={buckets[key]}
          generators={generators}
          genIdx={genIdx + 1}
          depth={depth + 1}
          basePath={path}
          expanded={expanded}
          toggle={toggle}
          childrenOf={childrenOf}
          data={data}
          projectIdent={projectIdent}
          meta={meta}
          childGenerators={childGenerators}
        />
      );
    }
  }
  return out;
}

function ItemRow({
  item, depth, expanded, toggle, childrenOf, data, projectIdent, meta, childGenerators,
}: { item: WorkItem; depth: number; expanded: Set<string>; toggle: (id: string) => void; childrenOf: Record<string, WorkItem[]>; data: DashboardData; projectIdent: string; meta?: { workspace_slug?: string }; childGenerators: ExplorerField[] }) {
  const children = childrenOf[item.id] || [];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(item.id);
  const typeColor = item.type_color || TYPE_COLORS[item.type] || '#888780';
  const prio = PRIORITY_INFO[item.priority] || PRIORITY_INFO.none;
  const indent = Array.from({ length: depth }).map((_, i) => <span key={i} className="indent-guide" />);
  return (
    <>
      <div className="srow">
        <div className="scell scell-summary">
          {indent}
          {hasChildren ? (
            <button className="chevron" onClick={() => toggle(item.id)}>{isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
          ) : <span className="chevron-spacer" />}
          <span className="type-icon" style={{ background: typeColor }} title={item.type} />
          <a className="row-seq" href={planeItemUrl(item.seq, { id: '', identifier: projectIdent }, meta)} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}>
            {projectIdent}-{item.seq}
          </a>
          <span className="row-name">{item.name}</span>
          {hasChildren && <span className="group-count">{children.length}</span>}
          <span className="ml-auto"><EditWorkItem item={item} /></span>
        </div>
        <div className="scell"><AssigneeCell name={item.assignee} color={item.assignee_color} /></div>
        <div className="scell"><span className={'badge ' + stateCls(item.state_group, data)}>{item.state}</span></div>
        <div className="scell"><span className={'badge ' + prio.cls}>{prio.label}</span></div>
        <div className="scell"><span style={{ color: typeColor, fontSize: 11 }}>{item.type}</span></div>
      </div>
      {hasChildren && isExpanded && (
        <Rows
          items={children}
          generators={childGenerators}
          genIdx={0}
          depth={depth + 1}
          basePath={'/' + item.id}
          expanded={expanded}
          toggle={toggle}
          childrenOf={childrenOf}
          data={data}
          projectIdent={projectIdent}
          meta={meta}
          childGenerators={childGenerators}
        />
      )}
    </>
  );
}

function RuleEditor({
  level, generators, setGenerators,
}: { level: 'root' | 'child'; generators: Generators; setGenerators: (g: Generators) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.add-rule-wrap')) setMenuOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);
  const rules = generators[level];
  const available = (Object.keys(FIELDS) as ExplorerField[]).filter(f => !rules.includes(f));
  return (
    <div className="builder-rules">
      {rules.map((field, idx) => (
        <span key={field}>
          {idx > 0 && <span className="rule-arrow">→</span>}
          <span className="rule-pill">
            <span className="pill-order">{idx + 1}</span>
            <i className={'ti ' + FIELDS[field].icon} />
            {FIELDS[field].label}
            <button className="pill-x" onClick={() => setGenerators({ ...generators, [level]: rules.filter(f => f !== field) })}>×</button>
          </span>
        </span>
      ))}
      <div className="add-rule-wrap">
        <button className="add-rule-btn" onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}>
          <i className="ti ti-plus" />{rules.length === 0 ? 'Group children by' : 'add'}
        </button>
        <div className={'rule-menu' + (menuOpen ? ' open' : '')}>
          {available.length === 0 ? (
            <div className="rule-menu-empty">All fields used</div>
          ) : available.map(f => (
            <button key={f} className="rule-menu-item" onClick={() => {
              setGenerators({ ...generators, [level]: [...rules, f] });
              setMenuOpen(false);
            }}>
              <i className={'ti ' + FIELDS[f].icon} />{FIELDS[f].label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ExplorerView() {
  const { data, currentProject } = useDashboard();
  const projectIdent = projectPrefix(currentProject);
  const [generators, setGenerators] = useState<Generators>({ root: [], child: [] });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [builderCollapsed, setBuilderCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Summary fills available space; everything else fits its content unless dragged.
  const cols = useResizableCols({
    order: ['summary', 'assignee', 'state', 'priority', 'type'] as const,
    initial: { summary: '1fr', assignee: 'auto', state: 'auto', priority: 'auto', type: 'auto' },
  });

  const { roots, childrenOf } = useMemo(() => {
    const childrenOf: Record<string, WorkItem[]> = {};
    const roots: WorkItem[] = [];
    if (data) for (const i of data.items) {
      if (i.parent) (childrenOf[i.parent] = childrenOf[i.parent] || []).push(i);
      else roots.push(i);
    }
    return { roots, childrenOf };
  }, [data]);

  // Default-expand portfolio entries.
  useEffect(() => {
    if (!data) return;
    setExpanded(prev => {
      const n = new Set(prev);
      (data.portfolios || []).forEach(p => n.add(p.id));
      return n;
    });
  }, [data]);

  const isFlat = searchQuery.trim() !== '' || sortKey !== null;

  const flatRows = useMemo<WorkItem[]>(() => {
    if (!data || !isFlat) return [];
    let rows: WorkItem[] = data.items.slice();
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      rows = rows.filter(it =>
        it.name.toLowerCase().includes(q) ||
        `${projectIdent}-${it.seq}`.toLowerCase().includes(q) ||
        (it.assignee || '').toLowerCase().includes(q) ||
        (it.state || '').toLowerCase().includes(q) ||
        (it.priority || '').toLowerCase().includes(q) ||
        (it.type || '').toLowerCase().includes(q),
      );
    }
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      const stateOrder = GROUP_ORDER.state_group || [];
      rows.sort((a, b) => {
        let va: string | number = '';
        let vb: string | number = '';
        if (sortKey === 'summary')       { va = a.name.toLowerCase();              vb = b.name.toLowerCase(); }
        else if (sortKey === 'assignee') { va = (a.assignee || '~').toLowerCase(); vb = (b.assignee || '~').toLowerCase(); }
        else if (sortKey === 'state')    { va = stateOrder.indexOf(a.state_group); vb = stateOrder.indexOf(b.state_group);
                                            if (va === vb) { va = a.state.toLowerCase(); vb = b.state.toLowerCase(); } }
        else if (sortKey === 'priority') { va = PRIORITY_RANK[a.priority] ?? 0;    vb = PRIORITY_RANK[b.priority] ?? 0; }
        else if (sortKey === 'type')     { va = a.type.toLowerCase();              vb = b.type.toLowerCase(); }
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }
    return rows;
  }, [data, isFlat, searchQuery, sortKey, sortDir, projectIdent]);

  if (!data) return <div className="text-sm text-muted-foreground p-4">No data.</div>;

  const totalRules = generators.root.length + generators.child.length;
  const itemCount = data.items.length;
  const toggle = (id: string) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const reset = () => { setGenerators({ root: [], child: [] }); setExpanded(new Set((data.portfolios || []).map(p => p.id))); };

  const cycleSort = (k: SortKey) => {
    if (sortKey !== k) { setSortKey(k); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortKey(null);
    setSortDir('asc');
  };
  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const featureCount = data.items.filter(i => i.type === 'Feature').length;
  const portfolioCount = (data.portfolios || []).length;
  const completedCount = data.items.filter(i => i.state_group === 'completed').length;

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="kpi kpi-cool">
          <div className="kpi-label"><span className="kpi-dot" />Total items</div>
          <div className="kpi-value">{itemCount}</div>
          <div className="kpi-sub">in the {data._meta?.window_days ?? 183}d window</div>
        </div>
        <div className="kpi kpi-violet">
          <div className="kpi-label"><span className="kpi-dot" />Features</div>
          <div className="kpi-value">{featureCount}</div>
          <div className="kpi-sub"><strong>{portfolioCount}</strong> active portfolios</div>
        </div>
        <div className="kpi kpi-warm">
          <div className="kpi-label"><span className="kpi-dot" />Top-level</div>
          <div className="kpi-value">{roots.length}</div>
          <div className="kpi-sub"><strong>{itemCount - roots.length}</strong> children</div>
        </div>
        <div className="kpi kpi-good">
          <div className="kpi-label"><span className="kpi-dot" />Completed</div>
          <div className="kpi-value">{completedCount}</div>
          <div className="kpi-sub">{itemCount > 0 ? Math.round(100 * completedCount / itemCount) : 0}% of all items</div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium flex items-center gap-2"><i className="ti ti-eye" />Active Feature initiatives</h2>
          <span className="text-xs text-muted-foreground">Top 6 Features by descendant count</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {(data.portfolios || []).map(p => (
            <PortfolioCard key={p.id} p={p} projectIdent={projectIdent} meta={data._meta} />
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium flex items-center gap-2"><i className="ti ti-list-tree" />Work item hierarchy</h2>
          <span className="text-xs text-muted-foreground">{itemCount} items · {roots.length} roots · {itemCount - roots.length} children</span>
        </div>
        <div className={'builder' + (builderCollapsed ? ' collapsed' : '')}>
          <div className="builder-head" onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setBuilderCollapsed(c => !c); }}>
            <ChevronDown className="builder-toggle h-4 w-4" />
            <span className="builder-title">Structure</span>
            <span className="groupby-meta">
              {totalRules === 0 ? `Pure hierarchy · ${itemCount} items` : `${totalRules} grouping rule${totalRules !== 1 ? 's' : ''}`}
            </span>
            {totalRules > 0 && (
              <button className="btn-reset" onClick={reset}><i className="ti ti-restore" />Reset to hierarchy</button>
            )}
          </div>
          <div className="builder-body">
            <div className="builder-row">
              <span className="builder-num">1</span>
              <span className="builder-scope"><span className="builder-from">Top level</span><i className="ti ti-arrow-narrow-right builder-arrow" /><span className="builder-to">Root items</span></span>
              <span className="builder-count">{roots.length} items</span>
              <RuleEditor level="root" generators={generators} setGenerators={setGenerators} />
            </div>
            <div className="builder-row">
              <span className="builder-num">2</span>
              <span className="builder-scope"><span className="builder-from">Parent</span><i className="ti ti-arrow-narrow-right builder-arrow" /><span className="builder-to">Children</span></span>
              <span className="builder-count">{itemCount - roots.length} items</span>
              <RuleEditor level="child" generators={generators} setGenerators={setGenerators} />
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, ID, assignee, state…"
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
          {isFlat && (
            <span className="text-xs text-muted-foreground">
              {flatRows.length} match{flatRows.length === 1 ? '' : 'es'}
              {totalRules > 0 && <span className="ml-2">· grouping suspended</span>}
            </span>
          )}
          {(sortKey || searchQuery) && (
            <button
              type="button"
              onClick={() => { setSearchQuery(''); setSortKey(null); }}
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />Clear filters
            </button>
          )}
        </div>

        <div className="stable-header mt-2" style={{ borderRadius: '8px 8px 0 0', ['--explorer-cols' as string]: cols.gridTemplate } as React.CSSProperties}>
          {(['summary','assignee','state','priority','type'] as SortKey[]).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => cycleSort(k)}
              className="relative flex items-center gap-1.5 text-left uppercase tracking-wider text-[11px] font-medium hover:text-foreground transition-colors bg-transparent border-0 p-0 cursor-pointer"
              style={{ color: sortKey === k ? 'var(--foreground)' : undefined }}
            >
              {k === 'summary' ? 'Summary' : k.charAt(0).toUpperCase() + k.slice(1)}
              <SortIcon k={k} />
              <span className="col-resize" onMouseDown={cols.startDrag(k)} onClick={(e) => e.stopPropagation()} />
            </button>
          ))}
        </div>
        <div className="rounded-b-lg border border-border border-t-0 bg-card overflow-hidden" style={{ ['--explorer-cols' as string]: cols.gridTemplate } as React.CSSProperties}>
          {isFlat ? (
            flatRows.length === 0 ? (
              <div className="action-empty">No items match.</div>
            ) : (
              flatRows.map(it => (
                <ItemRow
                  key={it.id}
                  item={it}
                  depth={0}
                  expanded={new Set()}
                  toggle={() => {}}
                  childrenOf={{}}
                  data={data}
                  projectIdent={projectIdent}
                  meta={data._meta}
                  childGenerators={[]}
                />
              ))
            )
          ) : (
            <Rows
              items={roots}
              /* If user only set a Children rule, apply it at the root level too —
                 setting any grouping rule should produce visible grouping. */
              generators={generators.root.length > 0 ? generators.root : generators.child}
              genIdx={0}
              depth={0}
              basePath=""
              expanded={expanded}
              toggle={toggle}
              childrenOf={childrenOf}
              data={data}
              projectIdent={projectIdent}
              meta={data._meta}
              childGenerators={generators.child.length > 0 ? generators.child : generators.root}
            />
          )}
        </div>
      </section>
    </div>
  );
}
