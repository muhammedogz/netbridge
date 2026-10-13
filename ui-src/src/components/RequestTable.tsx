import { useLayoutEffect, useRef } from 'react';
import type { CapturedRequest } from '../types';
import { fmtSize } from '../lib';
import { StatusBadge } from './StatusBadge';

// An id segment (`/users/42`, `/orders/<uuid>`) says little on its own.
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{24,})$/i;

// Name first, like the DevTools Network tab: the last path segment is what
// tells requests apart, so a narrow column truncates the host, not the name.
function UrlCell({ url }: { url: string }) {
  try {
    const u = new URL(url);
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

interface Props {
  requests: CapturedRequest[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Detail pane is open: keep only the columns that identify a request. */
  compact: boolean;
}

export function RequestTable({ requests, total, selectedId, onSelect, compact }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Sticky auto-scroll: follow new rows only when the user is near the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the rows change
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [requests]);

  return (
    <div
      id="list"
      ref={listRef}
      onScroll={() => {
        const el = listRef.current;
        if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      <table className={compact ? 'compact' : undefined}>
        <thead>
          <tr>
            <th className="opt">#</th>
            <th className="opt">method</th>
            <th>name</th>
            <th>status</th>
            <th className="opt">time</th>
            <th className="opt">size</th>
            <th className="opt">via</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr
              key={r.id}
              className={r.id === selectedId ? 'selected' : ''}
              onClick={() => onSelect(r.id)}
            >
              <td className="seq opt">{r.seq}</td>
              <td className={`method opt ${r.method}`}>{r.method}</td>
              <td className="url" title={r.url}>
                <UrlCell url={r.url} />
              </td>
              <td>
                <StatusBadge r={r} />
              </td>
              <td className="opt">{r.durationMs != null ? `${r.durationMs} ms` : ''}</td>
              <td className="opt">{fmtSize(r.resBody, r.resBodyEncoding)}</td>
              <td className="src opt">
                {r.source || ''}
                {r.pid ? <span title="pid"> #{r.pid}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total === 0 && (
        <div id="empty">
          waiting for server-side requests…
          <br />
          traffic from fetch, ky, axios, got &amp; co. appears here live
        </div>
      )}
      {total > 0 && requests.length === 0 && (
        <div id="empty">
          no requests match the filter
          <br />
          {total} hidden
        </div>
      )}
    </div>
  );
}
