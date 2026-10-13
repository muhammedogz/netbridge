/**
 * The --overlay bubble, shown in an iframe on the app's pages. Collapsed it
 * is a pill summing up the latest inbound request (the page itself, then
 * whatever it calls on its server); expanded it lists recent inbound
 * requests with the waterfall of the one picked.
 *
 * It polls short summaries (no bodies), so it stays cheap however much the
 * collector holds.
 */
import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntrySummary } from '../../src/protocol';
import { Waterfall } from './components/Waterfall';
import { statusClassOf } from './filter';
import { buildTree } from './tree';
import type { CapturedRequest } from './types';
import './styles.css';
import './overlay.css';

const POLL_MS = 1500;
const trace = new URLSearchParams(location.search).get('trace') ?? '';
// Requests from before this page loaded belong to other pages.
const loadedAt = Date.now();

type Summary = EntrySummary & CapturedRequest;

function asRows(list: EntrySummary[]): Summary[] {
  return list.map((e, i) => ({ ...e, seq: i + 1 }) as Summary);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Tell the page how big the iframe should be. */
function useSize(ref: React.RefObject<HTMLDivElement | null>, radius: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const post = () => {
      const { width, height } = el.getBoundingClientRect();
      parent.postMessage({ netbridge: 'size', width: Math.ceil(width), height: Math.ceil(height), radius }, '*');
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, radius]);
}

function Overlay() {
  const [inbound, setInbound] = useState<Summary[]>([]);
  const [calls, setCalls] = useState<Summary[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [version, setVersion] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  useSize(boxRef, open ? 10 : 16);

  // The page's own request first; once later ones arrive, the newest.
  const latest = inbound.length ? inbound[inbound.length - 1] : undefined;
  const shownId = picked ?? latest?.id ?? trace;

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((c) => setVersion(typeof c.version === 'string' ? c.version : ''))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/requests?summary=1&source=inbound&limit=30');
        const list = (await res.json()) as EntrySummary[];
        // Only this page's request and what came after it.
        if (!stop) setInbound(asRows(list.filter((e) => e.id === trace || e.ts >= loadedAt)));
        const kids = await fetch(`/api/requests?summary=1&parent=${encodeURIComponent(shownId)}`);
        if (!stop) setCalls(asRows((await kids.json()) as EntrySummary[]));
        if (!stop) setOffline(false);
      } catch {
        if (!stop) setOffline(true);
      }
    };
    poll();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [shownId]);

  const shown = inbound.find((e) => e.id === shownId);
  const tree = useMemo(() => buildTree(calls, (c) => (c as Summary).key), [calls]);
  const failed = calls.some((c) => ['error', '4xx', '5xx'].includes(statusClassOf(c) ?? ''));
  const repeated = tree.repeats.size > 0;
  const tone = offline ? 'off' : failed ? 'bad' : repeated ? 'warn' : 'ok';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!open) {
    return (
      <div ref={boxRef} className="ov-pill-wrap">
        <button type="button" className="ov-pill" onClick={() => setOpen(true)} title="netbridge: server calls of this page">
          <span className={`ov-dot ${tone}`} />
          <span className="ov-brand">nb</span>
          {offline ? (
            <span>offline</span>
          ) : (
            <span>
              {calls.length} call{calls.length === 1 ? '' : 's'}
              {repeated ? ` · ${tree.repeats.size} repeated` : ''}
              {failed ? ' · failed' : ''}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="ov-panel">
      <div className="ov-head">
        <span className={`ov-dot ${tone}`} />
        <strong>netbridge</strong>
        {version && <span className="ov-dim">v{version}</span>}
        <span className="ov-dim">· server calls per request</span>
        <a href={`/#${encodeURIComponent(shownId)}`} target="_blank" rel="noreferrer" className="ov-link">
          open in netbridge ↗
        </a>
        <button type="button" className="ov-close" aria-label="close" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div className="ov-body">
        <div className="ov-list">
          {[...inbound].reverse().map((e) => (
            <button
              type="button"
              key={e.id}
              className={`ov-item${e.id === shownId ? ' on' : ''}`}
              onClick={() => setPicked(e.id)}
              title={e.url}
            >
              <span className={`method ${e.method}`}>{e.method}</span>{' '}
              {e.kind && <span className={`tag kind ${e.kind}`}>{e.kind === 'navigation' ? 'nav' : e.kind}</span>}
              {e.serverAction?.name ? `${e.serverAction.name} · ${pathOf(e.url)}` : pathOf(e.url)}
            </button>
          ))}
          {inbound.length === 0 && <div className="ov-dim">nothing recorded yet</div>}
        </div>
        <div className="ov-detail">
          {shown ? (
            <Waterfall
              parent={shown}
              tree={tree}
              onSelect={(id) => window.open(`/#${encodeURIComponent(id)}`, '_blank')}
            />
          ) : (
            <div className="ov-dim">no outbound calls recorded for this request</div>
          )}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
);
