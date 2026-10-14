import { useEffect, useMemo } from 'react';
import { hostStats } from '../../../src/protocol';
import type { CapturedRequest } from '../types';

function ms(v: number | undefined): string {
  return v == null ? '' : `${v} ms`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Every backend the app called, with its call count, failures and timing.
 * Picking a host narrows the list to it.
 */
export function HostsDialog({
  requests,
  onPick,
  onClose,
}: {
  requests: readonly CapturedRequest[];
  onPick: (host: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stats = useMemo(() => hostStats(requests), [requests]);
  const slowest = Math.max(0, ...stats.map((s) => s.p95 ?? 0));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; Esc and close work too
    <div
      className="resend-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal hosts-modal" role="dialog" aria-label="hosts">
        <h3>hosts</h3>
        <div className="modal-label">
          outbound calls per backend, across everything captured. p50 and p95 are over finished calls; click a host to
          filter the list to it.
        </div>
        {stats.length === 0 ? (
          <div className="modal-label">no outbound calls yet</div>
        ) : (
          <table className="hosts">
            <thead>
              <tr>
                <th>host</th>
                <th>calls</th>
                <th>failed</th>
                <th>p50</th>
                <th>p95</th>
                <th>max</th>
                <th>received</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.host} onClick={() => onPick(s.host)} title={`show only ${s.host}`}>
                  <td className="hosts-name">{s.host}</td>
                  <td>
                    {s.calls}
                    {s.pending ? <span className="pending"> ({s.pending} running)</span> : null}
                  </td>
                  <td className={s.failed ? 'error' : ''}>{s.failed || ''}</td>
                  <td>{ms(s.p50)}</td>
                  <td>
                    <span className="hosts-bar-wrap">
                      <span className="hosts-bar" style={{ width: `${slowest ? ((s.p95 ?? 0) / slowest) * 100 : 0}%` }} />
                      <span>{ms(s.p95)}</span>
                    </span>
                  </td>
                  <td>{ms(s.max)}</td>
                  <td>{size(s.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
