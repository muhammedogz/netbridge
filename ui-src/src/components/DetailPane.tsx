import { useEffect, useRef, useState } from 'react';
import { REDACTED, startedAt } from '../../../src/protocol';
import type { CapturedRequest } from '../types';
import { displayBody, downloadBlob, downloadBody, headersText, resendRequest, timingTitle } from '../lib';
import type { Tree } from '../tree';
import { CopyButton } from './CopyButton';
import { CopyMenu } from './CopyMenu';
import { MockEditor, draftFromEntry } from './Mocks';
import { ResendDialog } from './ResendDialog';
import { StatusBadge } from './StatusBadge';
import { SseBody, TimingSection } from './Stream';
import { TokensSection, fromHeaders, hasStaleToken, tokensInBody } from './Tokens';
import { Waterfall } from './Waterfall';

type Kind = 'response' | 'request';
type Tab = Kind | 'calls';

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

const WIDTH_KEY = 'netbridge-detail-width';

function storedWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Drag handle on the pane's left edge. The width it sets is still clamped by
 * the CSS min/max, so the request list always keeps room for its name column.
 */
function Resizer({ onResize, onDone }: { onResize: (px: number) => void; onDone: (px: number) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`resizer${dragging ? ' dragging' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const main = e.currentTarget.parentElement?.getBoundingClientRect();
        if (main) onResize(Math.round(main.right - e.clientX));
      }}
      onPointerUp={(e) => {
        setDragging(false);
        // Persist the width the pane actually got after the CSS clamp.
        const pane = e.currentTarget.nextElementSibling;
        if (pane) onDone(Math.round(pane.getBoundingClientRect().width));
      }}
    />
  );
}

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
              <button type="button" className="iconbtn" onClick={() => downloadBody(r, kind)}>
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
            {isRes && encoding !== 'base64' && /text\/event-stream/i.test(headers?.['content-type'] ?? '') ? (
              <SseBody text={body} />
            ) : (
              <pre>{text}</pre>
            )}
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
  parent,
  tree,
  onClose,
  onSelectEntry,
}: {
  r: CapturedRequest | null;
  /** The inbound request `r` was made for, when it is still in the buffer. */
  parent: CapturedRequest | null;
  tree: Tree;
  onClose: () => void;
  onSelectEntry: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('response');
  const [mocking, setMocking] = useState(false);
  const inbound = r?.source === 'inbound';
  // Inbound requests have no captured bodies: their calls are the point.
  const shownTab: Tab = inbound ? (tab === 'request' ? 'request' : 'calls') : tab === 'calls' ? 'response' : tab;
  const repeats = r ? tree.repeats.get(r.id) : undefined;
  const [width, setWidth] = useState(storedWidth);
  const [editing, setEditing] = useState(false);
  // Id of the entry with a resend in flight — survives selection changes so
  // the button state can't be reset out from under a pending send.
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  // The entry currently on screen; in-flight resends check it when they
  // settle so they never hijack the selection or mislabel another entry.
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = r?.id ?? null;

  // Selecting another entry must not carry over an open editor or stale state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new entry id
  useEffect(() => {
    setEditing(false);
    setMocking(false);
    setResendError(null);
  }, [r?.id]);

  // Success feedback is the selection jumping to the new replay entry —
  // but only while the user is still looking at the entry they resent.
  const resendAsIs = async (id: string) => {
    setResendingId(id);
    setResendError(null);
    try {
      const entry = await resendRequest({ id });
      if (currentIdRef.current === id) onSelectEntry(entry.id);
    } catch (err) {
      if (currentIdRef.current === id) {
        setResendError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setResendingId((cur) => (cur === id ? null : cur));
    }
  };

  const asIsWarnings = r
    ? [
        r.reqBodyTruncated ? 'body was truncated at capture' : null,
        Object.values(r.reqHeaders ?? {}).includes(REDACTED)
          ? 'redacted header values will be dropped'
          : null,
      ].filter(Boolean)
    : [];

  return (
    <>
      {r && (
        <Resizer
          onResize={setWidth}
          onDone={(px) => {
            setWidth(px);
            try {
              localStorage.setItem(WIDTH_KEY, String(px));
            } catch {
              /* ignore */
            }
          }}
        />
      )}
    <div id="detail" className={r ? 'open' : ''} style={r && width ? { width } : undefined}>
      {r && (
        <div className="inner">
          <button type="button" className="close" aria-label="close" onClick={onClose}>
            ✕
          </button>
          <h2>
            <span className={`method ${r.method}`}>{r.method}</span> {r.url}{' '}
            <CopyButton text={r.url} label="copy url" />
          </h2>
          <div>
            <StatusBadge r={r} /> {r.statusText || ''}
            {r.durationMs != null && (
              <span className="badge" title={timingTitle(r)}>
                {r.durationMs} ms
              </span>
            )}
            <span className="badge">{r.source || ''}</span>
            {r.pid != null && <span className="badge">pid {r.pid}</span>}
            {r.replayOf && (
              <button
                type="button"
                className="badge replay-link"
                title="jump to the original request"
                onClick={() => onSelectEntry(r.replayOf as string)}
              >
                replay of {r.replayOf}
              </button>
            )}
            {r.parentId && (
              <button
                type="button"
                className="badge replay-link"
                title="the inbound request this call was made for"
                disabled={!parent}
                onClick={() => onSelectEntry(r.parentId as string)}
              >
                for {parent ? `${parent.method} ${pathOf(parent.url)}` : 'an inbound request no longer in the list'}
              </button>
            )}
            {repeats && (
              <span className="badge dup" title="same method, url and body under the same inbound request">
                ran {repeats}× for this request
              </span>
            )}
            {hasStaleToken(r) && (
              <span className="badge bad" title="a JWT in the request headers was expired or not valid yet: see the Request tab">
                token expired
              </span>
            )}
            {r.mocked && (
              <span className="badge mock" title="answered by a mock rule, not the real backend">
                mocked by rule {r.mocked}
              </span>
            )}
            {!inbound && (
              <>
                <CopyMenu r={r} />
                <button
                  type="button"
                  className="iconbtn"
                  title={
                    're-issue this request unchanged' +
                    (asIsWarnings.length ? ` — ${asIsWarnings.join('; ')}` : '')
                  }
                  disabled={resendingId === r.id}
                  onClick={() => resendAsIs(r.id)}
                >
                  {resendingId === r.id ? 'sending…' : 'resend'}
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  title="edit method, url, headers or body, then resend"
                  onClick={() => setEditing(true)}
                >
                  edit &amp; resend
                </button>
              </>
            )}
            {!inbound && r.source !== 'replay' && (
              <button
                type="button"
                className="iconbtn"
                title="answer this call with a canned response from now on, starting from the captured one"
                onClick={() => setMocking(true)}
              >
                mock
              </button>
            )}
            <button
              type="button"
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
          <div className="tabbar" role="tablist">
            {((inbound ? ['calls', 'request'] : ['response', 'request']) as Tab[]).map((k) => (
              <button
                type="button"
                key={k}
                className={`tab ${shownTab === k ? 'active' : ''}`}
                role="tab"
                aria-selected={shownTab === k}
                onClick={() => setTab(k)}
              >
                {k === 'response' ? 'Response' : k === 'calls' ? 'Calls' : 'Request'}
              </button>
            ))}
          </div>
          {shownTab === 'calls' ? (
            <div className="section">
              <Waterfall parent={r} tree={tree} onSelect={onSelectEntry} />
              <div className="section">
                <div className="sec-head">
                  <h3>response headers</h3>
                </div>
                <HeadersGrid headers={r.resHeaders} />
              </div>
            </div>
          ) : inbound ? (
            <>
              <TokensSection tokens={fromHeaders(r.reqTokens)} at={startedAt(r)} title="tokens" />
            <div className="section">
              <div className="sec-head">
                <h3>request headers</h3>
                <CopyButton text={() => headersText(r.reqHeaders)} />
              </div>
              <HeadersGrid headers={r.reqHeaders} />
            </div>
            </>
          ) : (
            <>
              {shownTab === 'response' && <TimingSection r={r} />}
              {shownTab === 'request' && (
                <TokensSection tokens={fromHeaders(r.reqTokens)} at={startedAt(r)} title="tokens" />
              )}
              <BodySection r={r} kind={shownTab as Kind} />
              {shownTab === 'response' && (
                <TokensSection
                  tokens={tokensInBody(r.resBody, r.resBodyEncoding)}
                  at={startedAt(r)}
                  title="tokens in the response"
                />
              )}
            </>
          )}
          {mocking && <MockEditor initial={draftFromEntry(r)} onClose={() => setMocking(false)} />}
          {editing && (
            <ResendDialog
              r={r}
              onClose={() => setEditing(false)}
              onResent={(id) => {
                setEditing(false);
                // A submit that settles after the user moved on must not
                // yank the selection to the replay entry.
                if (currentIdRef.current === r.id) onSelectEntry(id);
              }}
            />
          )}
        </div>
      )}
    </div>
    </>
  );
}
