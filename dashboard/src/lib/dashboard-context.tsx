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
  currentProjectId: string | null;
  setCurrentProjectId: (id: string) => void;
  currentProject: ProjectSummary | null;
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
  const [currentProjectId, setCurrentProjectIdState] = useState<string | null>(null);
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

  const setCurrentProjectId = useCallback((id: string) => {
    setCurrentProjectIdState(id);
    try { localStorage.setItem(STORAGE_KEYS.project, id); } catch { /* ignore */ }
  }, []);

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
    if (!activeValid || !workspaceSlug) { setProjects([]); setCurrentProjectIdState(null); return; }
    let cancelled = false;
    (async () => {
      setStatus('loading');
      setErrorMsg(null);
      try {
        const body = await api.projects(workspaceSlug);
        if (cancelled) return;
        const list = body.projects || [];
        setProjects(list);
        const saved = (() => { try { return localStorage.getItem(STORAGE_KEYS.project); } catch { return null; } })();
        let pick: string | null = null;
        if (saved && list.some(p => p.id === saved)) pick = saved;
        else if (body.default_project_id && list.some(p => p.id === body.default_project_id)) pick = body.default_project_id;
        else if (list.length) pick = list[0].id;
        setCurrentProjectIdState(pick);
        if (!pick) setStatus('ready');
      } catch (e) {
        if (!cancelled) { setErrorMsg((e as Error).message); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceSlug, activeValid]);

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
  useEffect(() => {
    if (!currentProjectId || !workspaceSlug) return;
    const token = `${workspaceSlug}:${currentProjectId}`;
    inflightId.current = token;
    (async () => {
      setStatus('loading');
      setErrorMsg(null);
      setRawData(null);
      setHistory([]);
      try {
        const d = await api.data(workspaceSlug, currentProjectId);
        if (inflightId.current !== token) return;
        const h = await api.history(workspaceSlug, currentProjectId);
        if (inflightId.current !== token) return;
        setRawData(d);
        setHistory(h);
        setStatus('ready');
      } catch {
        // Cache miss — first encounter with this project. Pull from Plane.
        setStatus('fetching');
        try {
          await api.refresh(workspaceSlug, currentProjectId);
          if (inflightId.current !== token) return;
          const d = await api.data(workspaceSlug, currentProjectId);
          if (inflightId.current !== token) return;
          const h = await api.history(workspaceSlug, currentProjectId);
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
  }, [currentProjectId, workspaceSlug]);

  const refresh = useCallback(async () => {
    if (!currentProjectId || !workspaceSlug) return;
    setRefreshing(true);
    try {
      await api.refresh(workspaceSlug, currentProjectId);
      const d = await api.data(workspaceSlug, currentProjectId);
      const h = await api.history(workspaceSlug, currentProjectId);
      setRawData(d);
      setHistory(h);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [currentProjectId, workspaceSlug]);

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
    currentProject, data, rawData, history, actions, refresh, refreshing,
    windowDays: effectiveWindow, setWindowDays, maxWindowDays,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
