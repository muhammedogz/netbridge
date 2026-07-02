import { useDeferredValue, useMemo, useState } from 'react';
import { useRequests } from './useRequests';
import { RequestTable } from './components/RequestTable';
import { ThemeToggle } from './components/ThemeToggle';
import { DetailPane } from './components/DetailPane';
import { ExportMenu, type ExportKind } from './components/ExportMenu';
import { buildHar, downloadBlob, matchesFilter } from './lib';
import type { CapturedRequest } from './types';

export function App() {
  const { requests, live, clearAll } = useRequests();
  const [filterText, setFilterText] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Defer the expensive scan (bodies can total hundreds of MB) so keystrokes
  // render immediately and the row list catches up a frame later.
  const deferredFilter = useDeferredValue(filterText);

  const filtered = useMemo(() => {
    if (!deferredFilter.trim()) return requests;
    return requests.filter((r) => matchesFilter(r, deferredFilter));
  }, [requests, deferredFilter]);

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
          {filterText ? `${filtered.length}/${requests.length}` : requests.length}
        </span>
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
      <main>
        <RequestTable
          requests={filtered}
          total={requests.length}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
        <DetailPane r={selected} onClose={() => setSelectedId(null)} />
      </main>
    </>
  );
}
