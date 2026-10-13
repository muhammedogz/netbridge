import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRequests } from './useRequests';
import { useFilterText } from './useFilterText';
import { RequestTable } from './components/RequestTable';
import { ThemeToggle } from './components/ThemeToggle';
import { DetailPane } from './components/DetailPane';
import { ExportMenu, type ExportKind } from './components/ExportMenu';
import { FilterBar } from './components/FilterBar';
import { CopyButton } from './components/CopyButton';
import { MocksDialog } from './components/Mocks';
import { buildTree, toRows } from './tree';
import { agentApiInstructions, buildHar, downloadBlob } from './lib';
import {
  matchesFilter,
  matchesStructured,
  parseDurationMs,
  parseFilter,
  type StatusClass,
} from './filter';
import type { CapturedRequest, ViewConfig } from './types';

const FILTER_HELP = [
  'space-separated terms, all must match (case-insensitive)',
  'text: url, method, status, headers, bodies',
  '-term: hide what the term matches',
  'url: host: path: method: status: source: match one attribute',
  'e.g. -host:localhost:4318 method:post status:5xx',
].join('\n');

const GROUP_KEY = 'netbridge-group';

function idFromHash(): string | null {
  try {
    return decodeURIComponent(location.hash.slice(1)) || null;
  } catch {
    return null; // a malformed escape such as `#%`
  }
}

function storedGroup(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== '0';
  } catch {
    return true;
  }
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function App({ config }: { config: ViewConfig }) {
  const { requests, live, clearAll, mocks } = useRequests(config.bufferLimit);
  const [grouped, setGrouped] = useState(storedGroup);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showMocks, setShowMocks] = useState(false);
  const [filterText, setFilterText] = useFilterText(config);
  const [methods, setMethods] = useState<ReadonlySet<string>>(new Set());
  const [statuses, setStatuses] = useState<ReadonlySet<StatusClass>>(new Set());
  const [sources, setSources] = useState<ReadonlySet<string>>(new Set());
  const [durMin, setDurMin] = useState('');
  const [durMax, setDurMax] = useState('');
  // `#<id>` selects an entry: the overlay's "open in netbridge" links here.
  const [selectedId, setSelectedId] = useState<string | null>(() => idFromHash());
  // Defer the expensive scan (bodies can total hundreds of MB) so keystrokes
  // render immediately and the row list catches up a frame later.
  const deferredFilter = useDeferredValue(filterText);
  const terms = useMemo(() => parseFilter(deferredFilter), [deferredFilter]);

  // An inverted range (min > max) is flagged in the bar and ignored here.
  let minMs = parseDurationMs(durMin);
  let maxMs = parseDurationMs(durMax);
  if (minMs != null && maxMs != null && minMs > maxMs) minMs = maxMs = null;

  const anyStructured = methods.size + statuses.size + sources.size > 0 || minMs != null || maxMs != null;

  const filtered = useMemo(() => {
    const structured = { methods, statuses, sources, minMs, maxMs };
    const base = anyStructured ? requests.filter((r) => matchesStructured(r, structured)) : requests;
    if (terms.length === 0) return base;
    return base.filter((r) => matchesFilter(r, terms));
  }, [requests, terms, methods, statuses, sources, minMs, maxMs, anyStructured]);
  const hidden = requests.length - filtered.length;
  const tree = useMemo(() => buildTree(requests), [requests]);
  const rows = useMemo(() => toRows(filtered, tree, grouped, collapsed), [filtered, tree, grouped, collapsed]);
  const enabledMocks = mocks.filter((m) => m.enabled).length;

  useEffect(() => {
    const onHash = () => setSelectedId(idFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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

  const byId = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const parent = selected?.parentId ? (byId.get(selected.parentId) ?? null) : null;

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
          netbridge{' '}
          {config.version && (
            <span className="version" title="netbridge version">
              v{config.version}
            </span>
          )}{' '}
          <span>— server-side network tab</span>
        </h1>
        <input
          id="filter"
          type="text"
          placeholder="filter… (-exclude, host:, method:, status:)"
          title={FILTER_HELP}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <span id="count" title={hidden > 0 ? `${hidden} hidden by the filter` : undefined}>
          {filterText || anyStructured ? `${filtered.length}/${requests.length}` : requests.length}
        </span>
        <CopyButton
          className=""
          label="api"
          title="copy instructions that point an AI agent (or script) at the live capture API"
          text={() => agentApiInstructions(window.location.origin)}
        />
        <button
          type="button"
          className={grouped ? 'on' : ''}
          aria-pressed={grouped}
          title="show each call under the inbound request (page render, API route) that made it"
          onClick={() => {
            setGrouped((g) => {
              try {
                localStorage.setItem(GROUP_KEY, g ? '0' : '1');
              } catch {
                /* ignore */
              }
              return !g;
            });
          }}
        >
          group
        </button>
        <button
          type="button"
          className={enabledMocks ? 'on' : ''}
          title="mock rules: answer, delay or fail the app's outbound calls"
          onClick={() => setShowMocks(true)}
        >
          mocks{enabledMocks ? ` · ${enabledMocks}` : ''}
        </button>
        <ExportMenu onExport={onExport} />
        <button
          type="button"
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
          rows={rows}
          total={requests.length}
          tree={tree}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
          collapsed={collapsed}
          onToggleCollapsed={(id) => setCollapsed((s) => toggled(s, id))}
          compact={selected !== null}
        />
        <DetailPane
          r={selected}
          parent={parent}
          tree={tree}
          onClose={() => setSelectedId(null)}
          onSelectEntry={setSelectedId}
        />
      </main>
      {showMocks && <MocksDialog rules={mocks} onClose={() => setShowMocks(false)} />}
    </>
  );
}
