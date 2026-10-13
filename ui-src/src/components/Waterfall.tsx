import { callSteps, startedAt } from '../../../src/protocol';
import { statusClassOf } from '../filter';
import type { Tree } from '../tree';
import type { CapturedRequest } from '../types';
import { UrlCell } from './RequestTable';

const BAR_CLASS: Record<string, string> = { '2xx': 's2', '3xx': 's3', '4xx': 's4', '5xx': 's5', error: 's5' };

/**
 * The calls one inbound request made, on a shared time axis: the request
 * starts at 0 and the axis spans until it (or its last call) finished. Calls
 * that waited on each other step down like stairs; parallel ones line up.
 */
export function Waterfall({
  parent,
  tree,
  onSelect,
}: {
  parent: CapturedRequest;
  tree: Tree;
  onSelect: (id: string) => void;
}) {
  const calls = tree.children.get(parent.id) ?? [];
  if (calls.length === 0) return <pre>(no outbound calls)</pre>;

  const now = Date.now();
  const origin = startedAt(parent);
  const endOf = (r: CapturedRequest) => (r.state === 'pending' ? now : startedAt(r) + (r.durationMs ?? 0));
  const span = Math.max(endOf(parent), ...calls.map(endOf)) - origin || 1;
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / span) * 100))}%`;

  const repeated = calls.filter((c) => tree.repeats.has(c.id)).length;
  const failed = calls.filter((c) => {
    const cls = statusClassOf(c);
    return cls === 'error' || cls === '5xx' || cls === '4xx';
  }).length;
  const steps = callSteps(calls);

  return (
    <div className="waterfall">
      <div className="wf-summary">
        <span>
          {calls.length} call{calls.length === 1 ? '' : 's'}
        </span>
        {calls.length > 1 && (
          <span
            className={steps > 1 ? 'warn' : ''}
            title="runs of calls that overlap in time: calls in separate steps waited on each other"
          >
            {steps} sequential step{steps === 1 ? '' : 's'}
          </span>
        )}
        {repeated > 0 && (
          <span className="warn" title="calls with the same method, url and body">
            {repeated} repeated
          </span>
        )}
        {failed > 0 && <span className="bad">{failed} failed</span>}
        {parent.durationMs != null && <span>{parent.durationMs} ms total</span>}
      </div>
      <div className="wf-rows">
        {calls.map((c) => {
          const cls = statusClassOf(c);
          const repeats = tree.repeats.get(c.id);
          return (
            <button type="button" key={c.id} className="wf-row" onClick={() => onSelect(c.id)} title={c.url}>
              <span className="wf-name">
                {repeats && <span className="tag dup">×{repeats}</span>}
                {c.mocked && <span className="tag mock">mock</span>}
                <span className={`method ${c.method}`}>{c.method}</span> <UrlCell url={c.url} />
              </span>
              <span className={`wf-status ${cls === 'error' ? 'error' : c.status ? `status-${String(c.status)[0]}` : ''}`}>
                {cls === 'error' ? 'err' : cls === 'pending' ? '…' : c.status}
              </span>
              <span className="wf-track">
                <span
                  className={`wf-bar ${BAR_CLASS[cls ?? ''] ?? 'pending'}`}
                  style={{ left: pct(startedAt(c) - origin), width: `max(2px, ${pct(endOf(c) - startedAt(c))})` }}
                />
              </span>
              <span className="wf-ms">{c.durationMs != null ? `${c.durationMs} ms` : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
