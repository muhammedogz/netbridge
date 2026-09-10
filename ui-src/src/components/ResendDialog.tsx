import { useEffect, useState } from 'react';
import type { CapturedRequest } from '../types';
import { headersText, parseHeadersText, resendRequest } from '../lib';

const REDACTED_LITERAL = '«redacted»';
const COMMON_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface Draft {
  method: string;
  url: string;
  headersText: string;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

function draftFrom(r: CapturedRequest): Draft {
  return {
    method: r.method,
    url: r.url,
    headersText: headersText(r.reqHeaders),
    body: r.reqBody ?? '',
    bodyEncoding: r.reqBodyEncoding ?? 'utf8',
  };
}

export function ResendDialog({
  r,
  onClose,
  onResent,
}: {
  r: CapturedRequest;
  onClose: () => void;
  onResent: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(r));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasRedacted = draft.headersText.includes(REDACTED_LITERAL);
  const hasDpop = Object.keys(parseHeadersText(draft.headersText)).some(
    (k) => k.toLowerCase() === 'dpop'
  );
  const isBinary = draft.bodyEncoding === 'base64';

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const hadBody = r.reqBody != null;
      const entry = await resendRequest({
        id: r.id,
        method: draft.method.trim().toUpperCase(),
        url: draft.url.trim(),
        headers: parseHeadersText(draft.headersText),
        body: draft.body === '' && !hadBody ? undefined : draft.body,
        bodyEncoding: draft.bodyEncoding,
      });
      onResent(entry.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <div
      className="resend-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label="edit and resend request">
        <h3>edit &amp; resend</h3>
        {hasRedacted && (
          <div className="modal-note">
            headers with the value {REDACTED_LITERAL} were redacted at capture and will be
            dropped on send — paste real values to include them
          </div>
        )}
        {hasDpop && (
          <div className="modal-note">
            DPoP proof is bound to this request's method, URL and token (single-use jti) — a
            resend will likely be rejected
          </div>
        )}
        {r.reqBodyTruncated && (
          <div className="modal-note">
            body was truncated at capture — only the captured bytes will be sent
          </div>
        )}
        <div className="modal-row">
          <input
            className="modal-method"
            list="resend-methods"
            value={draft.method}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}
            aria-label="method"
          />
          <datalist id="resend-methods">
            {COMMON_METHODS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <input
            className="modal-url"
            value={draft.url}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            aria-label="url"
            placeholder="https://…"
          />
        </div>
        <label className="modal-label">headers — one "Key: value" per line</label>
        <textarea
          className="modal-text"
          rows={6}
          value={draft.headersText}
          disabled={pending}
          onChange={(e) => setDraft((d) => ({ ...d, headersText: e.target.value }))}
          aria-label="headers"
        />
        <label className="modal-label">
          body
          {isBinary && (
            <>
              {' '}
              <span className="badge">binary — resent verbatim</span>
              <button
                className="iconbtn"
                disabled={pending}
                onClick={() => setDraft((d) => ({ ...d, body: '', bodyEncoding: 'utf8' }))}
              >
                clear body
              </button>
            </>
          )}
        </label>
        <textarea
          className="modal-text"
          rows={8}
          value={draft.body}
          readOnly={isBinary}
          disabled={pending}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          aria-label="body"
        />
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button disabled={pending} onClick={onClose}>
            cancel
          </button>
          <button className="modal-send" disabled={pending} onClick={submit}>
            {pending ? 'sending…' : 'resend'}
          </button>
        </div>
      </div>
    </div>
  );
}
