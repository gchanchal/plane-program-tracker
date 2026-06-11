/**
 * App-level Context: dashboard data, projects, history, computed actions, refresh
 * action. Mirrors what `state.js` + `main.js` did in the vanilla codebase.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { computeActions } from './actions';
import { STORAGE_KEYS } from './constants';
import type {
  ActionBuckets, DashboardData, HistorySnapshot, ProjectSummary,
} from './types';

type LoadStatus = 'idle' | 'loading' | 'fetching' | 'ready' | 'error';

interface DashboardContextValue {
  status: LoadStatus;
  errorMsg: string | null;
  /** Workspaces the user has added (most-recent first). null until /api/me resolves. */
  workspaces: string[] | null;
  /** Active workspace — taken from the URL's first path segment. */
  workspaceSlug: string | null;
  /** Validate + remember a workspace (URL or slug), then navigate into it. */
  addWorkspace: (urlOrSlug: string) => Promise<void>;
  projects: ProjectSummary[];
  /** Primary selected project (first of the selection) — for single-project fallbacks. */
  currentProjectId: string | null;
  setCurrentProjectId: (id: string) => void;
  currentProject: ProjectSummary | null;
  /** All selected projects. One = normal view; several = combined program view. */
  selectedProjectIds: string[];
  setSelectedProjectIds: (ids: string[]) => void;
  /** True when more than one project is selected (combined view). */
  isMulti: boolean;
  /** Selection as a URL-friendly identifier list, e.g. "WEB,PHOENIX". */
  selectedProjectParam: string;
  /** Filtered + recomputed view of the cached data, scoped to `windowDays`. */
  data: DashboardData | null;
  /** Original server-cached snapshot (full window). Useful for window picker bounds. */
  rawData: DashboardData | null;
  history: HistorySnapshot[];
  actions: ActionBuckets | null;
  refresh: () => Promise<void>;
  refreshing: boolean;
  /** Active display window. Capped at the server-cached window. */
  windowDays: number;
  setWindowDays: (n: number) => void;
  /** Server's max cached window — upper bound for windowDays. */
  maxWindowDays: number;
}

const Ctx = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboard must be used inside <DashboardProvider>');
  return v;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[] | null>(null);
  const [selectedProjectIds, setSelectedProjectIdsState] = useState<string[]>([]);
  const currentProjectId = selectedProjectIds[0] ?? null;
  const isMulti = selectedProjectIds.length > 1;
  const [rawData, setRawData] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [windowDays, setWindowDays] = useState<number>(0); // 0 = use server max
  const inflightId = useRef<string | null>(null);

  const location = useLocation();
  const navigate = useNavigate();
  // Active workspace = first path segment, e.g. /acme/roadmap -> "acme". Null at "/".
  const workspaceSlug = location.pathname.split('/').filter(Boolean)[0] || null;
  const activeValid = !!workspaceSlug && !!workspaces?.includes(workspaceSlug);

  const setSelectedProjectIds = useCallback((ids: string[]) => {
    setSelectedProjectIdsState(ids);
    try { localStorage.setItem(STORAGE_KEYS.project, JSON.stringify(ids)); } catch { /* ignore */ }
  }, []);
  // Back-compat single-select setter.
  const setCurrentProjectId = useCallback((id: string) => {
    setSelectedProjectIds([id]);
  }, [setSelectedProjectIds]);

  // Bootstrap: load the remembered workspaces list (the active one comes from the URL).
  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setWorkspaces(me.workspaces || []);
      } catch {
        setWorkspaces([]);
      }
    })();
  }, []);

  // Load projects for the active workspace, then pick a project.
  useEffect(() => {
    if (!activeValid || !workspaceSlug) { setProjects([]); setSelectedProjectIdsState([]); return; }
    let cancelled = false;
    (async () => {
      setStatus('loading');
      setErrorMsg(null);
      try {
        const body = await api.projects(workspaceSlug);
        if (cancelled) return;
        const list = body.projects || [];
        setProjects(list);
        const valid = new Set(list.map(p => p.id));
        // Selection priority: URL (?projects=) so shared links open the right
        // project(s) → then the last saved selection → then the default.
        // URL tokens are project identifiers (WEB), but also accept raw UUIDs.
        const identToId = new Map(list.map(p => [(p.identifier || '').toLowerCase(), p.id]));
        const fromUrl = new URLSearchParams(location.search).get('projects');
        const urlIds = (fromUrl ? fromUrl.split(',') : [])
          .map(t => t.trim())
          .filter(Boolean)
          .map(t => (valid.has(t) ? t : identToId.get(t.toLowerCase())))
          .filter((x): x is string => !!x);
        const saved = (() => {
          try {
            const raw = localStorage.getItem(STORAGE_KEYS.project);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
          } catch {
            const raw = (() => { try { return localStorage.getItem(STORAGE_KEYS.project); } catch { return null; } })();
            return raw ? [raw] : [];
          }
        })();
        let pick = urlIds.filter(id => valid.has(id));
        if (!pick.length) pick = saved.filter(id => valid.has(id));
        if (!pick.length) {
          if (body.default_project_id && valid.has(body.default_project_id)) pick = [body.default_project_id];
          else if (list.length) pick = [list[0].id];
        }
        setSelectedProjectIdsState(pick);
        if (!pick.length) setStatus('ready');
      } catch (e) {
        if (!cancelled) { setErrorMsg((e as Error).message); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceSlug, activeValid]);

  // Selection as project identifiers (WEB, PHOENIX) for a readable, shareable URL.
  const selectedProjectParam = useMemo(
    () => selectedProjectIds.map(id => projects.find(p => p.id === id)?.identifier || id).join(','),
    [selectedProjectIds, projects],
  );

  // Keep the URL's ?projects= in sync with the current selection so the link is
  // shareable (and reflects which project's data is on screen). Replace, not push,
  // so it doesn't add history entries; tab links already carry the same query.
  useEffect(() => {
    if (!selectedProjectParam) return;
    const sp = new URLSearchParams(location.search);
    if (sp.get('projects') === selectedProjectParam) return;
    // Build the search by hand so the comma stays literal (?projects=WEB,PHOENIX)
    // rather than URLSearchParams' %2C, while preserving any other params.
    sp.delete('projects');
    const rest = sp.toString();
    const search = `?projects=${selectedProjectParam}` + (rest ? `&${rest}` : '');
    navigate({ pathname: location.pathname, search }, { replace: true });
  }, [selectedProjectParam, location.pathname, location.search, navigate]);

  // Load cached data + history when currentProjectId changes.
  //
  // Two cases:
  //  1. /api/data returns a cached JSON → use it as-is. No Plane API hit.
  //     This covers page reloads, tab switches, returning to a project we've
  //     already pulled.
  //  2. /api/data returns 404 (no cache yet for this project) → auto-fetch
  //     from Plane this *one* time. First-time projects shouldn't make the
  //     user click an empty Refresh button to see anything.
  //
  // Beyond that, refreshes from Plane only happen when the user clicks the
  // Refresh button (the `refresh` callback below).
  const dataKey = selectedProjectIds.join(',');
  useEffect(() => {
    if (!dataKey || !workspaceSlug) return;
    const ids = dataKey.split(',');
    const token = `${workspaceSlug}:${dataKey}`;
    inflightId.current = token;
    (async () => {
      setStatus('loading');
      setErrorMsg(null);
      setRawData(null);
      setHistory([]);
      try {
        const d = await api.data(workspaceSlug, dataKey);
        if (inflightId.current !== token) return;
        // Combined view has no single history series; only load history for one project.
        const h = ids.length === 1 ? await api.history(workspaceSlug, ids[0]) : [];
        if (inflightId.current !== token) return;
        setRawData(d);
        setHistory(h);
        setStatus('ready');
      } catch {
        // Cache miss — first encounter with these project(s). Pull each from Plane.
        setStatus('fetching');
        try {
          for (const id of ids) {
            await api.refresh(workspaceSlug, id);
            if (inflightId.current !== token) return;
          }
          const d = await api.data(workspaceSlug, dataKey);
          if (inflightId.current !== token) return;
          const h = ids.length === 1 ? await api.history(workspaceSlug, ids[0]) : [];
          if (inflightId.current !== token) return;
          setRawData(d);
          setHistory(h);
          setStatus('ready');
        } catch (e2) {
          setErrorMsg((e2 as Error).message);
          setStatus('error');
        }
      }
    })();
  }, [dataKey, workspaceSlug]);

  const refresh = useCallback(async () => {
    const ids = selectedProjectIds;
    if (!ids.length || !workspaceSlug) return;
    const key = ids.join(',');
    setRefreshing(true);
    try {
      for (const id of ids) {
        await api.refresh(workspaceSlug, id);
      }
      const d = await api.data(workspaceSlug, key);
      const h = ids.length === 1 ? await api.history(workspaceSlug, ids[0]) : [];
      setRawData(d);
      setHistory(h);
      // Due-date history is computed in a background thread per project and rewrites
      // the data file when done. Poll until all selected projects finish, then
      // re-fetch so the reschedule pills appear without a manual reload.
      void pollDueHistory(workspaceSlug, ids);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [selectedProjectIds, workspaceSlug]);

  const pollDueHistory = useCallback(async (slug: string, ids: string[]) => {
    // The first due-history pass can take several minutes when Plane is throttling.
    // Poll for up to ~20 min; the server persists progress every few items, so we
    // re-fetch data periodically to let the reschedule pills trickle in, plus a
    // final fetch once every selected project reports done.
    const key = ids.join(',');
    const stillViewing = () => slug === workspaceSlug && key === selectedProjectIds.join(',');
    for (let i = 0; i < 240; i++) {
      await new Promise(r => setTimeout(r, 5000));
      let anyRunning = false;
      for (const id of ids) {
        try {
          const st = await api.status(slug, id);
          if (st.due_history_in_progress) anyRunning = true;
        } catch { /* ignore a single status hiccup */ }
      }
      // Refresh visible data every ~20s while running so partial counts show up.
      if (stillViewing() && (!anyRunning || i % 4 === 3)) {
        try { setRawData(await api.data(slug, key)); } catch { /* keep current */ }
      }
      if (!anyRunning) return;
    }
  }, [workspaceSlug, selectedProjectIds]);

  const addWorkspace = useCallback(async (urlOrSlug: string) => {
    const res = await api.addWorkspace(urlOrSlug);
    setWorkspaces(res.workspaces);
    navigate(`/${res.workspace_slug}`);
  }, [navigate]);

  const currentProject = useMemo(
    () => projects.find(p => p.id === currentProjectId) || null,
    [projects, currentProjectId],
  );

  const maxWindowDays = rawData?._meta?.window_days || 183;
  const effectiveWindow = windowDays > 0 ? Math.min(windowDays, maxWindowDays) : maxWindowDays;

  /**
   * Apply the user-selected display window. We filter `items` by created_at and
   * recompute the aggregates that views read so the entire dashboard reflects
   * the chosen window without a server round-trip. Portfolios are recomputed
   * by re-walking the parent-child tree against the filtered set.
   */
  const data = useMemo<DashboardData | null>(() => {
    if (!rawData) return null;
    if (effectiveWindow >= maxWindowDays) {
      return { ...rawData, _meta: { ...rawData._meta, window_days: effectiveWindow } };
    }
    const cutoff = new Date(rawData.today + 'T00:00:00Z');
    cutoff.setUTCDate(cutoff.getUTCDate() - effectiveWindow);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const filteredItems = rawData.items.filter(i => (i.created_at || '').slice(0, 10) >= cutoffIso);
    const filteredIds = new Set(filteredItems.map(i => i.id));

    const groupCounts: Record<string, number> = {};
    const priorityCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    for (const i of filteredItems) {
      groupCounts[i.state_group] = (groupCounts[i.state_group] || 0) + 1;
      priorityCounts[i.priority] = (priorityCounts[i.priority] || 0) + 1;
      typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
    }
    const portfolios = (rawData.portfolios || []).filter(p => filteredIds.has(p.id));

    return {
      ...rawData,
      items: filteredItems,
      kpi: { ...rawData.kpi, total: filteredItems.length },
      group_counts: groupCounts as DashboardData['group_counts'],
      priority_counts: priorityCounts as DashboardData['priority_counts'],
      type_counts: typeCounts,
      portfolios,
      cutoff: cutoffIso,
      _meta: { ...rawData._meta, window_days: effectiveWindow },
    };
  }, [rawData, effectiveWindow, maxWindowDays]);

  const actions = useMemo(() => computeActions(data), [data]);

  // Title sync.
  useEffect(() => {
    const ident = currentProject?.identifier || currentProject?.name || 'Plane';
    document.title = ident + ' · Program dashboard';
  }, [currentProject]);

  const value: DashboardContextValue = {
    status, errorMsg, workspaces, workspaceSlug, addWorkspace,
    projects, currentProjectId, setCurrentProjectId,
    selectedProjectIds, setSelectedProjectIds, isMulti, selectedProjectParam,
    currentProject, data, rawData, history, actions, refresh, refreshing,
    windowDays: effectiveWindow, setWindowDays, maxWindowDays,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
