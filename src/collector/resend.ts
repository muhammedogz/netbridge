/**
 * Request replay (POST /api/resend): validates a resend payload against the
 * captured entry it refers to, then re-issues it from the collector process.
 */
import { BodyCollector, encodeBody, nextId, sanitizeHeaders } from '../capture/shared';
import { REDACTED } from '../protocol';
import type { BodyEncoding, Entry, NetbridgeEvent } from '../protocol';

const RESEND_TIMEOUT_MS = 30_000;

// Computed / hop-by-hop headers: fetch recomputes these, and a stale captured
// value (content-length after a body edit, the original host) breaks the send.
const DROP_ON_RESEND = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'expect',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'accept-encoding',
]);

// RFC 9110 token: the only characters legal in an HTTP header name.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface ResendSpec {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding?: BodyEncoding;
  /** The inherited captured body was truncated: the replay is lossy. */
  bodyTruncated?: boolean;
  replayOf?: string;
}

export type ParseResult = { spec: ResendSpec } | { status: number; error: string };

/**
 * Turn a resend payload into a spec. Fields the payload leaves out are
 * inherited from the captured entry named by `id`.
 */
export function parseResend(payload: unknown, lookup: (id: string) => Entry | undefined): ParseResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, error: 'invalid JSON body' };
  }
  const p = payload as Record<string, unknown>;
  const base = p.id != null ? lookup(String(p.id)) : undefined;
  if (p.id != null && !base) return { status: 404, error: `unknown request id: ${String(p.id)}` };

  const method = String(p.method ?? base?.method ?? '').toUpperCase();
  if (!/^[A-Z][A-Z-]*$/.test(method)) return { status: 400, error: 'invalid or missing method' };

  const url = String(p.url ?? base?.url ?? '');
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    return { status: 400, error: 'invalid or missing url (http/https only)' };
  }

  // Headers: only a flat object of primitive values, names limited to RFC 9110
  // tokens, values without CR/LF. Anything else is a caller bug that must
  // surface as a 400, not as garbage on the wire.
  let headers: Record<string, string>;
  if (p.headers !== undefined) {
    if (!p.headers || typeof p.headers !== 'object' || Array.isArray(p.headers)) {
      return { status: 400, error: 'headers must be an object of string values' };
    }
    headers = {};
    for (const [k, v] of Object.entries(p.headers)) {
      if (!HEADER_NAME.test(k)) return { status: 400, error: `invalid header name: ${JSON.stringify(k)}` };
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        return { status: 400, error: `header ${JSON.stringify(k)} must be a string` };
      }
      const value = String(v);
      if (/[\r\n]/.test(value)) return { status: 400, error: `invalid header value for ${JSON.stringify(k)}` };
      headers[k] = value;
    }
  } else {
    headers = base?.reqHeaders ?? {};
  }

  // Body: a string, null (send no body, even if the original had one), or
  // absent (inherit the captured body, including its truncation).
  let body: string | undefined;
  let bodyEncoding: BodyEncoding | undefined;
  let bodyTruncated = false;
  if (p.body === null) {
    body = undefined;
  } else if (typeof p.body === 'string') {
    body = p.body;
    bodyEncoding = p.bodyEncoding === 'base64' ? 'base64' : 'utf8';
  } else if (p.body !== undefined) {
    return { status: 400, error: 'body must be a string (or null for no body)' };
  } else {
    body = base?.reqBody;
    bodyEncoding = base?.reqBodyEncoding;
    bodyTruncated = base?.reqBodyTruncated === true;
  }

  return {
    spec: {
      method,
      url,
      headers,
      body,
      bodyEncoding,
      bodyTruncated,
      replayOf: p.id != null ? String(p.id) : undefined,
    },
  };
}

/**
 * Re-issue a request. The capture layer only instruments the app process, so
 * replay events are synthesized here and handed to `record`, which puts them
 * in the table and on the live feed. Resolves with the replay's id.
 */
export async function executeResend(spec: ResendSpec, record: (e: NetbridgeEvent) => void): Promise<string> {
  const id = nextId();
  const started = Date.now();
  const base = { id, pid: process.pid, source: 'replay' as const, method: spec.method, url: spec.url };
  const sendHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers)) {
    const lower = k.toLowerCase();
    // A redacted value would be guaranteed garbage auth: drop it.
    if (DROP_ON_RESEND.has(lower) || v === REDACTED) continue;
    sendHeaders[lower] = v;
  }
  // undici throws on GET/HEAD bodies.
  const hasBody = spec.body != null && !['GET', 'HEAD'].includes(spec.method);
  record({
    ...base,
    phase: 'start',
    ts: started,
    // Re-sanitize for the store: a user-re-entered token goes on the wire but
    // must never sit unredacted in the buffer or the SSE stream.
    reqHeaders: sanitizeHeaders(sendHeaders),
    ...(hasBody ? { reqBody: spec.body, reqBodyEncoding: spec.bodyEncoding ?? 'utf8' } : {}),
    // Mark a lossy replay: the sent body is the truncated captured prefix.
    ...(hasBody && spec.bodyTruncated ? { reqBodyTruncated: true } : {}),
    ...(spec.replayOf ? { replayOf: spec.replayOf } : {}),
  });
  try {
    const res = await fetch(spec.url, {
      method: spec.method,
      headers: sendHeaders,
      body: hasBody
        ? spec.bodyEncoding === 'base64'
          ? Buffer.from(spec.body as string, 'base64')
          : spec.body
        : undefined,
      // Show the true wire response (a 302 stays a 302), don't follow.
      redirect: 'manual',
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    const bodyCollector = new BodyCollector();
    if (res.body) {
      for await (const chunk of res.body) {
        bodyCollector.push(chunk);
        if (bodyCollector.truncated) break; // break auto-cancels the stream
      }
    }
    const encoded = bodyCollector.isEmpty ? null : encodeBody(bodyCollector.buffer());
    record({
      ...base,
      phase: 'end',
      ts: Date.now(),
      status: res.status,
      statusText: res.statusText,
      resHeaders: sanitizeHeaders(Object.fromEntries(res.headers)),
      ...(encoded ? { resBody: encoded.body, resBodyEncoding: encoded.encoding } : {}),
      ...(bodyCollector.truncated ? { resBodyTruncated: true } : {}),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    record({
      ...base,
      phase: 'error',
      ts: Date.now(),
      error: String(cause?.code || cause?.message || (err as Error)?.message || err),
      durationMs: Date.now() - started,
    });
  }
  return id;
}
