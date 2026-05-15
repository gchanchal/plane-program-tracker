/**
 * App-level Context: dashboard data, projects, history, computed actions, refresh
 * action. Mirrors what `state.js` + `main.js` did in the vanilla codebase.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
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
  const [currentProjectId, setCurrentProjectIdState] = useState<string | null>(null);
  const [rawData, setRawData] = useState<DashboardData | null>(null);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [windowDays, setWindowDays] = useState<number>(0); // 0 = use server max
  const inflightId = useRef<string | null>(null);

  const setCurrentProjectId = useCallback((id: string) => {
    setCurrentProjectIdState(id);
    try { localStorage.setItem(STORAGE_KEYS.project, id); } catch { /* ignore */ }
  }, []);

  // Bootstrap: load /api/projects, decide which project to open.
  useEffect(() => {
    (async () => {
      setStatus('loading');
      try {
        const body = await api.projects();
        const list = body.projects || [];
        setProjects(list);
        const saved = (() => {
          try { return localStorage.getItem(STORAGE_KEYS.project); } catch { return null; }
        })();
        let pick: string | null = null;
        if (saved && list.some(p => p.id === saved)) pick = saved;
        else if (body.default_project_id && list.some(p => p.id === body.default_project_id)) pick = body.default_project_id;
        else if (list.length) pick = list[0].id;
        if (!pick) {
          setStatus('ready');
          return;
        }
        setCurrentProjectIdState(pick);
      } catch (e) {
        setErrorMsg((e as Error).message);
        setStatus('error');
      }
    })();
  }, []);

  // Load data + history whenever currentProjectId changes.
  useEffect(() => {
    if (!currentProjectId) return;
    inflightId.current = currentProjectId;
    (async () => {
      setStatus('loading');
      setErrorMsg(null);
      try {
        const d = await api.data(currentProjectId);
        if (inflightId.current !== currentProjectId) return;
        const h = await api.history(currentProjectId);
        if (inflightId.current !== currentProjectId) return;
        setRawData(d);
        setHistory(h);
        setStatus('ready');
      } catch {
        // No cache yet — auto-fetch from Plane.
        setStatus('fetching');
        try {
          await api.refresh(currentProjectId);
          if (inflightId.current !== currentProjectId) return;
          const d = await api.data(currentProjectId);
          if (inflightId.current !== currentProjectId) return;
          const h = await api.history(currentProjectId);
          if (inflightId.current !== currentProjectId) return;
          setRawData(d);
          setHistory(h);
          setStatus('ready');
        } catch (e2) {
          setErrorMsg((e2 as Error).message);
          setStatus('error');
        }
      }
    })();
  }, [currentProjectId]);

  const refresh = useCallback(async () => {
    if (!currentProjectId) return;
    setRefreshing(true);
    try {
      await api.refresh(currentProjectId);
      const d = await api.data(currentProjectId);
      const h = await api.history(currentProjectId);
      setRawData(d);
      setHistory(h);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [currentProjectId]);

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
    status, errorMsg, projects, currentProjectId, setCurrentProjectId,
    currentProject, data, rawData, history, actions, refresh, refreshing,
    windowDays: effectiveWindow, setWindowDays, maxWindowDays,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
