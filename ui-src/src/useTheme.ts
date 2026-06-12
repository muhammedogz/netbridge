import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'netbridge-theme';

/**
 * Theme state. The initial value is applied to <html data-theme> by the
 * inline script in index.html (before first paint, so no flash); this hook
 * just mirrors and updates it.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) || 'dark'
  );

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode etc. */
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
