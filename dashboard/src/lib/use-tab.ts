import { useCallback, useState } from 'react';
import { STORAGE_KEYS } from './constants';

export type TabKey = 'pulse' | 'mywork' | 'action' | 'due' | 'capacity' | 'flow' | 'explorer';

const VALID: TabKey[] = ['pulse', 'mywork', 'action', 'due', 'capacity', 'flow', 'explorer'];

function readTab(): TabKey {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.tab);
    if (v && (VALID as string[]).includes(v)) return v as TabKey;
  } catch { /* ignore */ }
  return 'pulse';
}

export function useTab() {
  const [tab, setTabState] = useState<TabKey>(() => readTab());
  const setTab = useCallback((next: TabKey) => {
    setTabState(next);
    try { localStorage.setItem(STORAGE_KEYS.tab, next); } catch { /* ignore */ }
  }, []);
  return { tab, setTab };
}
