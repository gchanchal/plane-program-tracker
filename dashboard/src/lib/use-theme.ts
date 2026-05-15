/** Three-state theme cycle (light → dark → system) with localStorage persistence. */
import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from './constants';

export type ThemePref = 'light' | 'dark' | 'system';

function systemEffective(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.theme);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

function applyToDom(pref: ThemePref) {
  const eff = pref === 'system' ? systemEffective() : pref;
  document.documentElement.classList.toggle('dark', eff === 'dark');
  document.documentElement.dataset.themePref = pref;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => readPref());

  useEffect(() => { applyToDom(pref); }, [pref]);

  // Re-apply when system preference changes (only relevant in 'system' mode).
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (pref === 'system') applyToDom('system'); };
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [pref]);

  const cycle = useCallback(() => {
    setPref(prev => {
      const next: ThemePref = prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light';
      try { localStorage.setItem(STORAGE_KEYS.theme, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const effective: 'light' | 'dark' = pref === 'system' ? systemEffective() : pref;
  return { pref, effective, cycle };
}
