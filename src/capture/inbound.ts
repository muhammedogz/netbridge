/**
 * Inbound requests: the ones the app's own server receives. Each request's
 * handler runs inside a correlation context (see context.ts), so the calls it
 * makes are grouped under it. An inbound request is recorded only once it
 * makes an outbound call: static files and HMR pings stay out of the list.
 *
 * Also reports the ports the app listens on (the DevTools panel uses them to
 * pick the collector of the page being inspected) and, with --overlay, adds
 * the netbridge bubble to the app's HTML pages.
 */
import type * as httpType from 'http';
import { tokensInHeaders } from '../protocol';
import { type InboundContext, runInbound } from './context';
import { serverAction } from './next';
import { config, emit, nextId, sanitizeHeaders, send } from './shared';

const overlay = process.env.NETBRIDGE_OVERLAY === '1';

function track(req: httpType.IncomingMessage, res: httpType.ServerResponse, protocol: string): InboundContext {
  const id = nextId();
  const ts = Date.now();
  const method = (req.method || 'GET').toUpperCase();
  const url = `${protocol}://${req.headers.host || 'localhost'}${req.url || '/'}`;
  const base = { id, pid: process.pid, source: 'inbound' as const, method, url };
  let opened = false;
  let closed = false;

  const finish = () => {
    const now = Date.now();
    if (res.writableFinished) {
      emit({
        ...base,
        phase: 'end',
        ts: now,
        status: res.statusCode,
        statusText: res.statusMessage,
        resHeaders: sanitizeHeaders(safeHeaders(res)),
        durationMs: now - ts,
      });
    } else {
      emit({ ...base, phase: 'error', ts: now, durationMs: now - ts, error: 'connection closed before the response finished' });
    }
  };
  const ctx: InboundContext = {
    id,
    open() {
      if (opened) return;
      opened = true;
      const action = req.headers['next-action'];
      emit({
        ...base,
        phase: 'start',
        ts,
        reqHeaders: sanitizeHeaders(req.headers),
        reqTokens: tokensInHeaders(req.headers),
        serverAction: typeof action === 'string' && action ? serverAction(action) : undefined,
      });
      // A call made after the response went out (fire-and-forget work).
      if (closed) finish();
    },
  };
  res.once('close', () => {
    closed = true;
    ctx.idleSince = Date.now();
    if (opened) finish();
  });

  if (overlay) injectOverlay(req, res, id);

  return ctx;
}

/**
 * The response headers as sent. Headers passed straight to writeHead() never
 * reach getHeaders(), so read the header block Node wrote when there is one.
 */
function safeHeaders(res: httpType.ServerResponse): Record<string, unknown> {
  try {
    const block = (res as unknown as { _header?: unknown })._header;
    if (typeof block !== 'string') return res.getHeaders();
    const out: Record<string, string> = {};
    for (const line of block.split('\r\n').slice(1)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      out[name] = name in out ? `${out[name]}, ${value}` : value;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// --overlay: append a script tag to HTML documents. The script lives on the
// collector and draws the bubble in an iframe of its own, so captured data
// never enters the app's page.
// ---------------------------------------------------------------------------

function injectOverlay(req: httpType.IncomingMessage, res: httpType.ServerResponse, traceId: string): void {
  if (req.method !== 'GET' || req.headers['sec-fetch-dest'] !== 'document') return;
  // Ask for an uncompressed page: a script tag can't be appended to gzip.
  delete req.headers['accept-encoding'];

  let decided = false;
  let inject = false;
  const decide = (headers?: unknown, status = res.statusCode) => {
    if (decided) return;
    decided = true;
    const get = (name: string): string => {
      const fromArg = headerFrom(headers, name);
      return String(fromArg ?? res.getHeader(name) ?? '');
    };
    inject =
      Number(status) === 200 &&
      /^text\/html/i.test(get('content-type')) &&
      !get('content-encoding') &&
      !get('content-security-policy');
    if (!inject) return;
    // The page grows by a script tag, so a declared length would be wrong.
    res.removeHeader('content-length');
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'content-length') delete (headers as Record<string, unknown>)[k];
      }
    }
  };

  const origWriteHead = res.writeHead;
  res.writeHead = function (this: httpType.ServerResponse, ...args: any[]) {
    try {
      const headers = args.find((a, i) => i > 0 && a && typeof a === 'object');
      // writeHead sets statusCode itself, after this wrapper runs.
      const status = args[0];
      if (Array.isArray(headers)) {
        // Flat [name, value, ...] form: drop content-length pairs in place.
        decide(Object.fromEntries(pairs(headers)), status);
        if (inject) {
          for (let i = headers.length - 2; i >= 0; i -= 2) {
            if (String(headers[i]).toLowerCase() === 'content-length') headers.splice(i, 2);
          }
        }
      } else {
        decide(headers, status);
      }
    } catch {
      /* never break the host app */
    }
    return (origWriteHead as any).apply(this, args);
  } as typeof res.writeHead;

  const origEnd = res.end;
  res.end = function (this: httpType.ServerResponse, ...args: any[]) {
    try {
      // A second end() is a no-op without netbridge; it must stay one.
      if (res.writableEnded) return (origEnd as any).apply(this, args);
      if (!res.headersSent) decide();
      if (inject) {
        inject = false;
        const tag = `<script src="http://127.0.0.1:${config.port}/overlay.js" data-trace="${traceId}" async></script>`;
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        if (args.length > 0 && args[0] != null) res.write(args[0], args[1]);
        return (origEnd as any).call(this, tag, 'utf8', cb);
      }
    } catch {
      /* fall through to the untouched end */
    }
    return (origEnd as any).apply(this, args);
  } as typeof res.end;
}

function headerFrom(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

function pairs(flat: unknown[]): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([String(flat[i]), flat[i + 1]]);
  return out;
}

// ---------------------------------------------------------------------------

function reportListen(server: httpType.Server): void {
  const address = server.address();
  if (address && typeof address === 'object') send({ kind: 'listen', pid: process.pid, port: address.port });
}

function patchServer(proto: httpType.Server, protocol: 'http' | 'https'): void {
  const original = proto.emit as (this: httpType.Server, event: string | symbol, ...args: any[]) => boolean;
  proto.emit = function (this: httpType.Server, event: string | symbol, ...args: any[]) {
    if (event === 'request') {
      let ctx: InboundContext | undefined;
      try {
        ctx = track(args[0], args[1], protocol);
      } catch {
        /* never break the host app */
      }
      if (ctx) return runInbound(ctx, () => original.call(this, event, ...args));
    } else if (event === 'listening') {
      try {
        reportListen(this);
      } catch {
        /* never break the host app */
      }
    }
    return original.call(this, event, ...args);
  } as typeof proto.emit;
}

export function patchInbound(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http') as typeof httpType;
  const https = require('https') as typeof import('https');
  patchServer(http.Server.prototype, 'http');
  patchServer(https.Server.prototype as unknown as httpType.Server, 'https');
}
