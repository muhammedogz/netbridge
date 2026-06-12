import { useMemo, useRef, useState } from 'react';
import { useRequests } from './useRequests';
import { RequestTable } from './components/RequestTable';
import { ThemeToggle } from './components/ThemeToggle';
import { DetailPane } from './components/DetailPane';
import { downloadBlob } from './lib';

export function App() {
  const { requests, live, clearAll } = useRequests();
  const [filterText, setFilterText] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportFlash, setExportFlash] = useState(false);
  const exportTimer = useRef<ReturnType<typeof setTimeout>>();

  const filtered = useMemo(() => {
    if (!filterText) return requests;
    const terms = filterText.toLowerCase().split(/\s+/);
    return requests.filter((r) => {
      const hay = `${r.method} ${r.url} ${r.status || ''} ${r.source || ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [requests, filterText]);

  const selected = selectedId ? (requests.find((r) => r.id === selectedId) ?? null) : null;

  const onExport = async () => {
    const res = await fetch('/api/requests');
    const data = await res.json();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `netbridge-export-${stamp}.json`
    );
    setExportFlash(true);
    clearTimeout(exportTimer.current);
    exportTimer.current = setTimeout(() => setExportFlash(false), 1200);
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
          placeholder="filter by url, method, status…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value.trim())}
        />
        <span id="count">
          {filterText ? `${filtered.length}/${requests.length}` : requests.length}
        </span>
        <button
          className={exportFlash ? 'flash' : ''}
          onClick={onExport}
          title="download all captured requests as JSON"
        >
          export
        </button>
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
