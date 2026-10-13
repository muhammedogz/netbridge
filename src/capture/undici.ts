/**
 * Calls made through undici's own API (`undici.request`, `Client`, `Pool`,
 * undici's `fetch`) never touch globalThis.fetch or the http module. undici
 * reports every request on diagnostics channels, so this listens there.
 *
 * Node's built-in fetch is undici too and reports on the same channels; the
 * fetch wrapper marks its calls (see context.ts) and they are skipped here.
 *
 * Response bodies arrive on `undici:request:bodyChunkReceived`, which undici
 * publishes from 7.x on. With an older undici the entry has headers, status
 * and timing but no response body.
 */
import * as dc from 'diagnostics_channel';
import { tokensInHeaders } from '../protocol';
import { currentParent, isInFetch } from './context';
import {
  BodyCollector,
  ChunkTimeline,
  announceSlowBody,
  chunkSize,
  decompressBody,
  emit,
  encodeBody,
  isOwnTraffic,
  nextId,
  sanitizeHeaders,
} from './shared';

interface State {
  id: string;
  start: number;
  method: string;
  url: string;
  /** Body given up front (a string or bytes); chunks sent are then ignored. */
  bodyKnown: boolean;
  reqBody: BodyCollector;
  resBody: BodyCollector;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  ttfbMs?: number;
  timeline: ChunkTimeline;
  cancelAnnounce?: () => void;
}

const states = new WeakMap<object, State>();

/**
 * undici's header shapes: a flat [name, value, ...] array of strings or
 * Buffers (6.x and later), or a raw `name: value\r\n` block (5.x).
 */
function parseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = String(raw[i]).toLowerCase();
      const value = String(raw[i + 1]);
      out[name] = name in out ? `${out[name]}, ${value}` : value;
    }
  } else if (typeof raw === 'string') {
    for (const line of raw.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

function body(collector: BodyCollector, contentEncoding?: string) {
  if (collector.isEmpty) return {};
  const raw = collector.buffer();
  // Partial compressed data can't be decoded: a truncated body stays as is.
  const decoded = collector.truncated || !contentEncoding ? raw : decompressBody(raw, contentEncoding);
  const { body: text, encoding } = encodeBody(decoded);
  return { body: text, encoding, truncated: collector.truncated || undefined };
}

function onCreate({ request }: { request: any }): void {
  if (isInFetch()) return;
  const url = `${String(request.origin).replace(/\/$/, '')}${request.path}`;
  if (!url.startsWith('http') || isOwnTraffic(url)) return;
  const method = String(request.method || 'GET').toUpperCase();
  // WebSocket handshakes and proxy tunnels never complete like a request.
  if (request.upgrade || method === 'CONNECT') return;
  const start = Date.now();
  const state: State = {
    id: nextId(),
    start,
    method,
    url,
    bodyKnown: false,
    reqBody: new BodyCollector(),
    resBody: new BodyCollector(),
    timeline: new ChunkTimeline(start),
  };
  if (typeof request.body === 'string' || request.body instanceof Uint8Array) {
    state.reqBody.push(request.body);
    state.bodyKnown = true;
  }
  states.set(request, state);
  const sent = state.bodyKnown ? body(state.reqBody) : {};
  emit({
    id: state.id,
    phase: 'start',
    ts: state.start,
    pid: process.pid,
    source: 'undici',
    method,
    url,
    parentId: currentParent(),
    reqHeaders: sanitizeHeaders(parseHeaders(request.headers)),
    reqTokens: tokensInHeaders(parseHeaders(request.headers)),
    reqBody: sent.body,
    reqBodyEncoding: sent.encoding,
    reqBodyTruncated: sent.truncated,
  });
}

function finish(request: object, state: State, phase: 'end' | 'error', error?: string): void {
  states.delete(request);
  state.cancelAnnounce?.();
  const sent = state.bodyKnown ? {} : body(state.reqBody);
  const received = body(state.resBody, state.resHeaders?.['content-encoding']);
  emit({
    id: state.id,
    phase,
    ts: Date.now(),
    pid: process.pid,
    source: 'undici',
    method: state.method,
    url: state.url,
    status: state.status,
    statusText: state.statusText,
    resHeaders: state.resHeaders ? sanitizeHeaders(state.resHeaders) : undefined,
    reqBody: sent.body,
    reqBodyEncoding: sent.encoding,
    reqBodyTruncated: sent.truncated,
    resBody: received.body,
    resBodyEncoding: received.encoding,
    resBodyTruncated: received.truncated,
    durationMs: Date.now() - state.start,
    ttfbMs: state.ttfbMs,
    resChunks: state.timeline.value(),
    error,
  });
}

// Held here: on older Node a channel nobody references can be collected,
// taking its subscribers with it.
const channels: dc.Channel[] = [];

function subscribe(name: string, handler: (message: any) => void): void {
  const channel = dc.channel(name);
  channels.push(channel);
  channel.subscribe((message: unknown) => {
    try {
      handler(message);
    } catch {
      /* never break the host app */
    }
  });
}

export function patchUndici(): void {
  subscribe('undici:request:create', onCreate);
  subscribe('undici:request:bodyChunkSent', ({ request, chunk }) => {
    const state = states.get(request);
    if (state && !state.bodyKnown) state.reqBody.push(chunk);
  });
  subscribe('undici:request:headers', ({ request, response }) => {
    const state = states.get(request);
    if (!state) return;
    state.status = response.statusCode;
    state.statusText = response.statusText;
    state.resHeaders = parseHeaders(response.headers);
    state.ttfbMs = Date.now() - state.start;
    state.cancelAnnounce = announceSlowBody({
      id: state.id,
      phase: 'response',
      ts: state.start,
      pid: process.pid,
      source: 'undici',
      method: state.method,
      url: state.url,
      status: state.status,
      statusText: state.statusText,
      resHeaders: sanitizeHeaders(state.resHeaders),
      ttfbMs: state.ttfbMs,
    });
  });
  subscribe('undici:request:bodyChunkReceived', ({ request, chunk }) => {
    const state = states.get(request);
    if (!state) return;
    state.timeline.add(chunkSize(chunk));
    state.resBody.push(chunk);
  });
  subscribe('undici:request:trailers', ({ request }) => {
    const state = states.get(request);
    if (state) finish(request, state, 'end');
  });
  subscribe('undici:request:error', ({ request, error }) => {
    const state = states.get(request);
    if (state) finish(request, state, 'error', error instanceof Error ? error.message : String(error));
  });
}
