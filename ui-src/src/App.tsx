import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRequests } from './useRequests';
import { RequestTable } from './components/RequestTable';
import { ThemeToggle } from './components/ThemeToggle';
import { DetailPane } from './components/DetailPane';
import { ExportMenu, type ExportKind } from './components/ExportMenu';
import { FilterBar } from './components/FilterBar';
import { CopyButton } from './components/CopyButton';
import {
  agentApiInstructions,
  buildHar,
  downloadBlob,
  matchesFilter,
  matchesStructured,
  parseDurationMs,
  type StatusClass,
} from './lib';
import type { CapturedRequest } from './types';

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function App() {
  const { requests, live, clearAll } = useRequests();
  const [filterText, setFilterText] = useState('');
  const [methods, setMethods] = useState<ReadonlySet<string>>(new Set());
  const [statuses, setStatuses] = useState<ReadonlySet<StatusClass>>(new Set());
  const [sources, setSources] = useState<ReadonlySet<string>>(new Set());
  const [durMin, setDurMin] = useState('');
  const [durMax, setDurMax] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Defer the expensive scan (bodies can total hundreds of MB) so keystrokes
  // render immediately and the row list catches up a frame later.
  const deferredFilter = useDeferredValue(filterText);

  // An inverted range (min > max) is flagged in the bar and ignored here.
  let minMs = parseDurationMs(durMin);
  let maxMs = parseDurationMs(durMax);
  if (minMs != null && maxMs != null && minMs > maxMs) minMs = maxMs = null;

  const anyStructured = methods.size + statuses.size + sources.size > 0 || minMs != null || maxMs != null;

  const filtered = useMemo(() => {
    const structured = { methods, statuses, sources, minMs, maxMs };
    const base = anyStructured ? requests.filter((r) => matchesStructured(r, structured)) : requests;
    if (!deferredFilter.trim()) return base;
    return base.filter((r) => matchesFilter(r, deferredFilter));
  }, [requests, deferredFilter, methods, statuses, sources, minMs, maxMs, anyStructured]);

  // Escape: leave the filter box first, then close the detail pane. Open
  // dropdown menus own the key themselves and must not also close the pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.copymenu-pop, .resend-overlay')) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.tagName === 'INPUT') {
        active.blur();
        return;
      }
      setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const selected = selectedId ? (requests.find((r) => r.id === selectedId) ?? null) : null;

  const onExport = async (kind: ExportKind) => {
    const res = await fetch('/api/requests');
    const data: CapturedRequest[] = await res.json();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (kind === 'har') {
      let version = '0.0.0';
      try {
        version = (await (await fetch('/api/health')).json()).version || version;
      } catch {
        /* keep fallback */
      }
      downloadBlob(
        new Blob([JSON.stringify(buildHar(data, version), null, 2)], { type: 'application/json' }),
        `netbridge-export-${stamp}.har`
      );
    } else {
      downloadBlob(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        `netbridge-export-${stamp}.json`
      );
    }
  };

  return (
    <>
      <header>
        <div id="live" className={live ? 'on' : ''} title="live connection" />
        <h1>
          netbridge <span>— server-side network tab</span>
        </h1>
        <input
          id="filter"
          type="text"
          placeholder="filter by url, method, status, body…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <span id="count">
          {filterText || anyStructured ? `${filtered.length}/${requests.length}` : requests.length}
        </span>
        <CopyButton
          className=""
          label="api"
          title="copy instructions that point an AI agent (or script) at the live capture API"
          text={() => agentApiInstructions(window.location.origin)}
        />
        <ExportMenu onExport={onExport} />
        <button
          onClick={async () => {
            await clearAll();
            setSelectedId(null);
          }}
        >
          clear
        </button>
        <ThemeToggle />
      </header>
      <FilterBar
        requests={requests}
        methods={methods}
        statuses={statuses}
        sources={sources}
        durMin={durMin}
        durMax={durMax}
        onToggleMethod={(m) => setMethods((s) => toggled(s, m))}
        onToggleStatus={(st) => setStatuses((s) => toggled(s, st))}
        onToggleSource={(src) => setSources((s) => toggled(s, src))}
        onDurMin={setDurMin}
        onDurMax={setDurMax}
        onClear={() => {
          setMethods(new Set());
          setStatuses(new Set());
          setSources(new Set());
          setDurMin('');
          setDurMax('');
        }}
      />
      <main>
        <RequestTable
          requests={filtered}
          total={requests.length}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
        <DetailPane r={selected} onClose={() => setSelectedId(null)} onSelectEntry={setSelectedId} />
      </main>
    </>
  );
}
