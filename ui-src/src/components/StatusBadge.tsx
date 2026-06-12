import type { CapturedRequest } from '../types';

export function StatusBadge({ r }: { r: CapturedRequest }) {
  if (r.state === 'error')
    return (
      <span className="error" title={r.error}>
        ERR
      </span>
    );
  if (r.state !== 'done') return <span className="pending">…</span>;
  return <span className={`status-${String(r.status)[0]}`}>{r.status ?? '?'}</span>;
}
