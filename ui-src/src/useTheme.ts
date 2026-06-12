import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'netbridge-theme';

const systemTheme = () =>
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

/**
 * Theme preference. 'light'/'dark' are explicit choices (persisted); 'system'
 * follows the OS live. 'system' is stored as the absence of the key — the same
 * convention the pre-paint script in index.html uses, so the first paint and
 * this hook always agree.
 */
export function useTheme(): { pref: ThemePref; cycle: () => void } {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      const t = localStorage.getItem(STORAGE_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = pref === 'system' ? systemTheme() : pref;
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      document.documentElement.dataset.theme = systemTheme();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const cycle = useCallback(() => {
    setPref((prev) => {
      const next: ThemePref = prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light';
      try {
        if (next === 'system') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode etc. */
      }
      return next;
    });
  }, []);

  return { pref, cycle };
}
