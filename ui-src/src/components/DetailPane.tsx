import { useEffect, useState } from 'react';
import type { CapturedRequest } from '../types';
import { displayBody, downloadBlob, downloadBody, headersText, resendRequest } from '../lib';
import { CopyButton } from './CopyButton';
import { CopyMenu } from './CopyMenu';
import { ResendDialog } from './ResendDialog';
import { StatusBadge } from './StatusBadge';

type Kind = 'response' | 'request';

function HeadersGrid({ headers }: { headers?: Record<string, string> }) {
  const entries = Object.entries(headers || {});
  if (!entries.length)
    return (
      <div className="kv">
        <span className="k">—</span>
        <span className="v" />
      </div>
    );
  return (
    <div className="kv">
      {entries.map(([k, v]) => (
        <span key={k} style={{ display: 'contents' }}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </span>
      ))}
    </div>
  );
}

function BodySection({ r, kind }: { r: CapturedRequest; kind: Kind }) {
  const isRes = kind === 'response';
  const body = isRes ? r.resBody : r.reqBody;
  const encoding = isRes ? r.resBodyEncoding : r.reqBodyEncoding;
  const truncated = isRes ? r.resBodyTruncated : r.reqBodyTruncated;
  const headers = isRes ? r.resHeaders : r.reqHeaders;
  const text = displayBody(body, encoding);

  return (
    <>
      <div className="section">
        <div className="sec-head">
          <h3>{kind} body</h3>
          {body != null && (
            <>
              <CopyButton text={() => text ?? ''} />
              <button className="iconbtn" onClick={() => downloadBody(r, kind)}>
                download
              </button>
            </>
          )}
        </div>
        {body == null ? (
          <pre>(no body captured)</pre>
        ) : (
          <>
            {encoding === 'base64' && <span className="badge">binary · base64</span>}
            {truncated && <span className="badge">truncated</span>}
            <pre>{text}</pre>
          </>
        )}
      </div>
      <div className="section">
        <div className="sec-head">
          <h3>{kind} headers</h3>
          <CopyButton text={() => headersText(headers)} />
        </div>
        <HeadersGrid headers={headers} />
      </div>
    </>
  );
}

export function DetailPane({
  r,
  onClose,
  onSelectEntry,
}: {
  r: CapturedRequest | null;
  onClose: () => void;
  onSelectEntry: (id: string) => void;
}) {
  const [tab, setTab] = useState<Kind>('response');
  const [editing, setEditing] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // Selecting another entry must not carry over an open editor or stale state.
  useEffect(() => {
    setEditing(false);
    setResending(false);
    setResendError(null);
  }, [r?.id]);

  // Success feedback is the selection jumping to the new replay entry.
  const resendAsIs = async (id: string) => {
    setResending(true);
    setResendError(null);
    try {
      const entry = await resendRequest({ id });
      onSelectEntry(entry.id);
    } catch (err) {
      setResendError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <div id="detail" className={r ? 'open' : ''}>
      {r && (
        <div className="inner">
          <span className="close" onClick={onClose}>
            ✕
          </span>
          <h2>
            <span className={`method ${r.method}`}>{r.method}</span> {r.url}{' '}
            <CopyButton text={r.url} label="copy url" />
          </h2>
          <div>
            <StatusBadge r={r} /> {r.statusText || ''}
            {r.durationMs != null && <span className="badge">{r.durationMs} ms</span>}
            <span className="badge">{r.source || ''}</span>
            {r.pid != null && <span className="badge">pid {r.pid}</span>}
            {r.replayOf && (
              <span
                className="badge replay-link"
                title="jump to the original request"
                onClick={() => onSelectEntry(r.replayOf as string)}
              >
                replay of {r.replayOf}
              </span>
            )}
            <CopyMenu r={r} />
            <button
              className="iconbtn"
              title="re-issue this request unchanged"
              disabled={resending}
              onClick={() => resendAsIs(r.id)}
            >
              {resending ? 'sending…' : 'resend'}
            </button>
            <button
              className="iconbtn"
              title="edit method, url, headers or body, then resend"
              onClick={() => setEditing(true)}
            >
              edit &amp; resend
            </button>
            <button
              className="iconbtn"
              title="download this entry as JSON"
              onClick={() =>
                downloadBlob(
                  new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }),
                  `netbridge-entry-${r.id}.json`
                )
              }
            >
              download entry
            </button>
            {r.error && (
              <div className="error" style={{ marginTop: 6 }}>
                {r.error}
              </div>
            )}
            {resendError && (
              <div className="error" style={{ marginTop: 6 }}>
                resend: {resendError}
              </div>
            )}
          </div>
          <div className="tabbar">
            {(['response', 'request'] as Kind[]).map((k) => (
              <div key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
                {k === 'response' ? 'Response' : 'Request'}
              </div>
            ))}
          </div>
          <BodySection r={r} kind={tab} />
          {editing && (
            <ResendDialog
              r={r}
              onClose={() => setEditing(false)}
              onResent={(id) => {
                setEditing(false);
                onSelectEntry(id);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
