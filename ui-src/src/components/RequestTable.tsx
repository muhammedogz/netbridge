import { useLayoutEffect, useRef } from 'react';
import type { CapturedRequest } from '../types';
import { fmtSize } from '../lib';
import { StatusBadge } from './StatusBadge';

function UrlCell({ url }: { url: string }) {
  try {
    const u = new URL(url);
    return (
      <>
        <span className="host">{u.host}</span>
        {u.pathname + u.search}
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
}

export function RequestTable({ requests, total, selectedId, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Sticky auto-scroll: follow new rows only when the user is near the bottom.
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
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>method</th>
            <th>url</th>
            <th>status</th>
            <th>time</th>
            <th>size</th>
            <th>via</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr
              key={r.id}
              className={r.id === selectedId ? 'selected' : ''}
              onClick={() => onSelect(r.id)}
            >
              <td className="seq">{r.seq}</td>
              <td className={`method ${r.method}`}>{r.method}</td>
              <td className="url" title={r.url}>
                <UrlCell url={r.url} />
              </td>
              <td>
                <StatusBadge r={r} />
              </td>
              <td>{r.durationMs != null ? `${r.durationMs} ms` : ''}</td>
              <td>{fmtSize(r.resBody, r.resBodyEncoding)}</td>
              <td className="src">
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
    </div>
  );
}
