import { useEffect, useState } from 'react';
import { withExclusions } from './filter';
import type { ViewConfig } from './types';

const FILTER_KEY = 'netbridge-filter';
// startedAt of the collector run whose --exclude patterns were last merged in.
const SEEDED_KEY = 'netbridge-filter-seeded';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

/** The collector's view config, or an empty one when it can't be read. */
export async function loadViewConfig(): Promise<ViewConfig> {
  try {
    const c = await (await fetch('/api/config')).json();
    return {
      exclude: Array.isArray(c.exclude) ? c.exclude.filter((p: unknown) => typeof p === 'string') : [],
      startedAt: Number(c.startedAt) || 0,
    };
  } catch {
    return { exclude: [], startedAt: 0 };
  }
}

/**
 * The header filter text, persisted across reloads. `--exclude` patterns are
 * merged in once per collector run: a reload keeps whatever the user edited
 * since, and the next `netbridge` start applies them again.
 */
export function useFilterText(config: ViewConfig): [string, (text: string) => void] {
  const [text, setText] = useState(() => {
    const stored = read(FILTER_KEY) ?? '';
    const newRun = config.exclude.length > 0 && read(SEEDED_KEY) !== String(config.startedAt);
    return newRun ? withExclusions(stored, config.exclude) : stored;
  });

  useEffect(() => {
    write(FILTER_KEY, text);
  }, [text]);

  useEffect(() => {
    if (config.exclude.length > 0) write(SEEDED_KEY, String(config.startedAt));
  }, [config]);

  return [text, setText];
}
