import { useEffect, useState } from 'react';
import { REDACTED } from '../../../src/protocol';
import type { MockRule } from '../../../src/protocol';
import { displayBody, headersText, parseHeadersText } from '../lib';
import type { CapturedRequest } from '../types';

type Mode = 'respond' | 'fail' | 'delay';

export interface Draft {
  id?: string;
  enabled: boolean;
  method: string;
  url: string;
  mode: Mode;
  delayMs: string;
  status: string;
  headersText: string;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  fail: string;
}

const EMPTY: Draft = {
  enabled: true,
  method: '',
  url: '',
  mode: 'respond',
  delayMs: '',
  status: '200',
  headersText: 'content-type: application/json',
  body: '',
  bodyEncoding: 'utf8',
  fail: 'backend unavailable',
};

// Headers that describe the captured wire bytes, not the decoded body the
// rule will send, and values the capture hid.
const SKIP_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'date']);

/** A rule that answers this request the way it was answered when captured. */
export function draftFromEntry(r: CapturedRequest): Draft {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.resHeaders ?? {})) {
    if (!SKIP_HEADERS.has(k.toLowerCase()) && v !== REDACTED) headers[k] = v;
  }
  return {
    ...EMPTY,
    method: r.method,
    url: r.url,
    mode: r.state === 'error' ? 'fail' : 'respond',
    status: String(r.status ?? 200),
    headersText: headersText(headers),
    // Pretty-printed when JSON: the rule is there to be edited.
    body: r.resBodyEncoding === 'base64' ? (r.resBody ?? '') : (displayBody(r.resBody, 'utf8') ?? ''),
    bodyEncoding: r.resBodyEncoding ?? 'utf8',
    fail: r.error ?? EMPTY.fail,
  };
}

function draftFromRule(rule: MockRule): Draft {
  return {
    ...EMPTY,
    id: rule.id,
    enabled: rule.enabled,
    method: rule.method,
    url: rule.url,
    mode: rule.response ? 'respond' : rule.fail ? 'fail' : 'delay',
    delayMs: rule.delayMs ? String(rule.delayMs) : '',
    status: String(rule.response?.status ?? 200),
    headersText: rule.response ? headersText(rule.response.headers) : EMPTY.headersText,
    body: rule.response?.body ?? '',
    bodyEncoding: rule.response?.bodyEncoding ?? 'utf8',
    fail: rule.fail ?? EMPTY.fail,
  };
}

function ruleFromDraft(d: Draft): Record<string, unknown> {
  const rule: Record<string, unknown> = { enabled: d.enabled, method: d.method.trim(), url: d.url.trim() };
  if (d.id) rule.id = d.id;
  if (d.delayMs.trim()) rule.delayMs = Number(d.delayMs);
  if (d.mode === 'respond') {
    rule.response = {
      status: Number(d.status),
      headers: parseHeadersText(d.headersText),
      body: d.body === '' ? undefined : d.body,
      bodyEncoding: d.bodyEncoding,
    };
  } else if (d.mode === 'fail') {
    rule.fail = d.fail.trim() || 'mocked network failure';
  }
  return rule;
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keep the status line */
    }
    throw new Error(message);
  }
  return res.status === 204 ? undefined : res.json();
}

export function saveMock(rule: Record<string, unknown>): Promise<unknown> {
  return call('/api/mocks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rule) });
}

function deleteMock(id: string): Promise<unknown> {
  return call(`/api/mocks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** One line describing what a rule does. */
function ruleSummary(rule: MockRule): string {
  const parts: string[] = [];
  if (rule.response) parts.push(`→ ${rule.response.status}`);
  else if (rule.fail) parts.push(`→ fail: ${rule.fail}`);
  else parts.push('→ real backend');
  if (rule.delayMs) parts.push(`after ${rule.delayMs} ms`);
  return parts.join(' ');
}

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function MockEditor({ initial, onClose }: { initial: Draft | MockRule; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => ('mode' in initial ? initial : draftFromRule(initial)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const isBinary = draft.bodyEncoding === 'base64';

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await saveMock(ruleFromDraft(draft));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; Esc and cancel close it too
    <div
      className="resend-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label="mock rule">
        <h3>{draft.id ? `mock rule ${draft.id}` : 'new mock rule'}</h3>
        <div className="modal-note">
          matching calls from the app get this answer instead of reaching the backend — fetch, axios, got and
          other http clients; takes effect immediately
        </div>
        <div className="modal-row">
          <input
            className="modal-method"
            list="mock-methods"
            value={draft.method}
            placeholder="any"
            onChange={(e) => set({ method: e.target.value })}
            aria-label="method"
          />
          <datalist id="mock-methods">
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <input
            className="modal-url"
            value={draft.url}
            onChange={(e) => set({ url: e.target.value })}
            aria-label="url pattern"
            placeholder="url contains… (or a pattern with *)"
          />
        </div>
        <div className="modal-row mock-modes" role="radiogroup" aria-label="what the rule does">
          {(
            [
              ['respond', 'respond with'],
              ['fail', 'fail (network error)'],
              ['delay', 'pass through'],
            ] as [Mode, string][]
          ).map(([mode, label]) => (
            <label key={mode} className="modal-label">
              <input type="radio" checked={draft.mode === mode} onChange={() => set({ mode })} /> {label}
            </label>
          ))}
          <label className="modal-label">
            delay
            <input
              className="mock-num"
              value={draft.delayMs}
              placeholder="0"
              inputMode="numeric"
              onChange={(e) => set({ delayMs: e.target.value })}
              aria-label="delay in ms"
            />
            ms
          </label>
        </div>
        {draft.mode === 'respond' && (
          <>
            <label className="modal-label">
              status
              <input
                className="mock-num"
                value={draft.status}
                inputMode="numeric"
                onChange={(e) => set({ status: e.target.value })}
                aria-label="status"
              />
            </label>
            <label className="modal-label" htmlFor="mock-headers">
              headers — one "Key: value" per line
            </label>
            <textarea
              id="mock-headers"
              className="modal-text"
              rows={4}
              value={draft.headersText}
              onChange={(e) => set({ headersText: e.target.value })}
            />
            <label className="modal-label" htmlFor="mock-body">
              body
              {isBinary && (
                <>
                  {' '}
                  <span className="badge">binary — sent verbatim</span>
                  <button type="button" className="iconbtn" onClick={() => set({ body: '', bodyEncoding: 'utf8' })}>
                    clear body
                  </button>
                </>
              )}
            </label>
            <textarea
              id="mock-body"
              className="modal-text"
              rows={10}
              value={draft.body}
              readOnly={isBinary}
              onChange={(e) => set({ body: e.target.value })}
            />
          </>
        )}
        {draft.mode === 'fail' && (
          <input
            className="modal-text"
            value={draft.fail}
            onChange={(e) => set({ fail: e.target.value })}
            aria-label="error message"
          />
        )}
        {draft.mode === 'delay' && (
          <div className="modal-label">the call goes to the real backend; its answer is held back by the delay</div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <label className="modal-label" style={{ marginRight: 'auto' }}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />{' '}
            enabled
          </label>
          <button type="button" disabled={pending} onClick={onClose}>
            cancel
          </button>
          <button type="button" className="modal-send" disabled={pending || !draft.url.trim()} onClick={submit}>
            {pending ? 'saving…' : 'save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MocksDialog({ rules, onClose }: { rules: MockRule[]; onClose: () => void }) {
  const [editing, setEditing] = useState<Draft | MockRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscape(() => {
    if (!editing) onClose();
  });

  const act = (p: Promise<unknown>) => {
    setError(null);
    p.catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (editing) return <MockEditor initial={editing} onClose={() => setEditing(null)} />;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; Esc and close work too
    <div
      className="resend-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label="mock rules">
        <h3>mock rules</h3>
        <div className="modal-label">
          the first enabled rule that matches a call answers it. Tip: "mock" in a request's detail pane starts a rule
          from its captured response.
        </div>
        {rules.length === 0 && <div className="modal-label">no rules yet</div>}
        <div className="mock-list">
          {rules.map((rule) => (
            <div key={rule.id} className={`mock-item${rule.enabled ? '' : ' off'}`}>
              <input
                type="checkbox"
                checked={rule.enabled}
                aria-label={rule.enabled ? 'disable' : 'enable'}
                onChange={() => act(saveMock({ ...rule, enabled: !rule.enabled }))}
              />
              <span className="mock-id">{rule.id}</span>
              <span className={`method ${rule.method}`}>{rule.method || 'any'}</span>
              <span className="mock-url" title={rule.url}>
                {rule.url}
              </span>
              <span className="mock-what">{ruleSummary(rule)}</span>
              <button type="button" className="iconbtn" onClick={() => setEditing(rule)}>
                edit
              </button>
              <button type="button" className="iconbtn" onClick={() => act(deleteMock(rule.id))}>
                delete
              </button>
            </div>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={() => setEditing({ ...EMPTY })}>
            new rule
          </button>
          <button type="button" className="modal-send" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
