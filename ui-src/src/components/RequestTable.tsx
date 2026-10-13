import { useLayoutEffect, useRef, useState } from 'react';
import { fmtSize, timingTitle } from '../lib';
import type { Row, Tree } from '../tree';
import { StatusBadge } from './StatusBadge';

// An id segment (`/users/42`, `/orders/<uuid>`) says little on its own.
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{24,})$/i;

// Name first, like the DevTools Network tab: the last path segment is what
// tells requests apart, so a narrow column truncates the host, not the name.
export function UrlCell({ url, gql }: { url: string; gql?: string[] }) {
  try {
    const u = new URL(url);
    if (gql?.length) {
      // GraphQL: every operation shares the url, so its name leads.
      const [type, ...name] = gql[0].split(' ');
      return (
        <>
          <span className={`tag gql ${type}`}>{type === 'subscription' ? 'sub' : type}</span>
          <span className="name">
            {name.join(' ')}
            {gql.length > 1 ? ` +${gql.length - 1}` : ''}
          </span>
          <span className="host">{u.host + u.pathname}</span>
        </>
      );
    }
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    let cut = path.lastIndexOf('/') + 1;
    if (cut > 1 && ID_SEGMENT.test(path.slice(cut))) cut = path.lastIndexOf('/', cut - 2) + 1;
    const segment = path.slice(cut);
    return (
      <>
        <span className="name">{(segment || u.host) + u.search}</span>
        {segment && <span className="host">{u.host + path.slice(0, cut)}</span>}
      </>
    );
  } catch {
    return <>{url}</>;
  }
}

/** Row height in px; every row is one line (see `tbody tr` in styles.css). */
const ROW_HEIGHT = 24;
/** Rows rendered beyond the viewport on each side, so fast scrolls don't flash. */
const OVERSCAN = 20;

/** Stands in for the rows outside the rendered window. */
function Spacer({ height }: { height: number }) {
  return (
    <tr className="spacer" style={{ height }} aria-hidden>
      <td colSpan={7} />
    </tr>
  );
}

interface Props {
  rows: Row[];
  total: number;
  tree: Tree;
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (id: string) => void;
}

/**
 * The request list. Only the rows in view (plus OVERSCAN) are in the DOM, so
 * a full buffer of thousands of requests scrolls and updates like a short one.
 */
export function RequestTable({ rows, total, tree, selectedId, onSelect, collapsed, onToggleCollapsed }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [view, setView] = useState({ top: 0, height: 800 });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sticky auto-scroll: follow new rows only when the user is near the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the rows change
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  // A selection made elsewhere (a link in the detail pane) scrolls into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on a new selection
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !selectedId) return;
    const idx = rows.findIndex((row) => row.r.id === selectedId);
    if (idx < 0) return;
    const y = idx * ROW_HEIGHT;
    // The sticky header covers the first row's worth of the viewport.
    if (y < el.scrollTop + ROW_HEIGHT || y > el.scrollTop + el.clientHeight - 2 * ROW_HEIGHT) {
      stickRef.current = false;
      el.scrollTop = Math.max(0, y - el.clientHeight / 3);
    }
  }, [selectedId]);

  const start = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div
      id="list"
      ref={listRef}
      onScroll={() => {
        const el = listRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        setView({ top: el.scrollTop, height: el.clientHeight });
      }}
    >
      <table>
        <thead>
          <tr>
            <th className="c-seq">#</th>
            <th className="c-method">method</th>
            <th>name</th>
            <th>status</th>
            <th className="c-time">time</th>
            <th className="c-size">size</th>
            <th className="c-via">via</th>
          </tr>
        </thead>
        <tbody>
          {start > 0 && <Spacer height={start * ROW_HEIGHT} />}
          {rows.slice(start, end).map(({ r, depth }) => {
            const inbound = r.source === 'inbound';
            const calls = inbound ? tree.children.get(r.id) : undefined;
            const repeats = tree.repeats.get(r.id);
            const cls = [r.id === selectedId ? 'selected' : '', inbound ? 'inbound' : '', depth ? 'child' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <tr key={r.id} className={cls} onClick={() => onSelect(r.id)}>
                <td className="seq c-seq">{r.seq}</td>
                <td className={`method c-method ${r.method}`}>{r.method}</td>
                <td className="url" title={r.url}>
                  {inbound && (
                    <button
                      type="button"
                      className="caret"
                      aria-label={collapsed.has(r.id) ? 'show calls' : 'hide calls'}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleCollapsed(r.id);
                      }}
                    >
                      {collapsed.has(r.id) ? '▸' : '▾'}
                    </button>
                  )}
                  {r.mocked && <span className="tag mock">mock</span>}
                  {r.gqlErrors && (
                    <span className="tag gqlerr" title={r.gqlErrors.join('\n')}>
                      {r.gqlErrors.length} error{r.gqlErrors.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {repeats && (
                    <span className="tag dup" title={`the same call ran ${repeats} times for this request`}>
                      ×{repeats}
                    </span>
                  )}
                  {calls && (
                    <span className="tag calls" title="outbound calls made while handling this request">
                      {calls.length} call{calls.length === 1 ? '' : 's'}
                    </span>
                  )}
                  <UrlCell url={r.url} gql={r.gql} />
                </td>
                <td>
                  <StatusBadge r={r} />
                </td>
                <td className="c-time" title={timingTitle(r)}>
                  {r.durationMs != null ? `${r.durationMs} ms` : ''}
                </td>
                <td className="c-size">{fmtSize(r.resBody, r.resBodyEncoding)}</td>
                <td className="src c-via">
                  {r.source || ''}
                  {r.pid ? <span title="pid"> #{r.pid}</span> : null}
                </td>
              </tr>
            );
          })}
          {end < rows.length && <Spacer height={(rows.length - end) * ROW_HEIGHT} />}
        </tbody>
      </table>
      {total === 0 && (
        <div id="empty">
          waiting for server-side requests…
          <br />
          traffic from fetch, ky, axios, got &amp; co. appears here live
        </div>
      )}
      {total > 0 && rows.length === 0 && (
        <div id="empty">
          no requests match the filter
          <br />
          {total} hidden
        </div>
      )}
    </div>
  );
}
