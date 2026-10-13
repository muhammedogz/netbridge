import type { CapturedRequest } from '../types';

export function StatusBadge({ r }: { r: CapturedRequest }) {
  if (r.state === 'error')
    return (
      <span className="error" title={r.error}>
        ERR
      </span>
    );
  if (r.state !== 'done') {
    // Headers in, body still coming: a stream.
    if (r.status != null)
      return (
        <span className={`status-${String(r.status)[0]}`} title="headers received, body still arriving">
          {r.status} <span className="pending">…</span>
        </span>
      );
    return <span className="pending">…</span>;
  }
  return <span className={`status-${String(r.status)[0]}`}>{r.status ?? '?'}</span>;
}
