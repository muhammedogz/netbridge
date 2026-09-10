/**
 * netbridge collector — runs inside the CLI process.
 *
 * Endpoints:
 *   GET  /              the web UI
 *   GET  /events        SSE stream of capture events (backlog + live)
 *   POST /ingest        NDJSON capture events from preloaded app processes
 *   GET  /api/requests  JSON dump of the merged request table
 *   POST /api/clear     reset the buffer
 *   POST /api/resend    re-issue a captured (optionally edited) request
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
// Runtime imports from shared are safe here: the collector never calls emit(),
// and the beforeExit flush no-ops without NETBRIDGE_PORT in this process.
import { BodyCollector, encodeBody, nextId, sanitizeHeaders } from './capture/shared';
import type { NetbridgeEvent } from './capture/shared';

const MAX_EVENTS = 4000;
// Hard cap on a single /ingest body: a buggy or runaway producer must never be
// able to OOM the collector. Comfortably fits a batch of NDJSON capture events.
const MAX_INGEST_BYTES = 16 * 1024 * 1024;
// Cap on a /api/resend payload: an edited body plus headers fits comfortably.
const MAX_RESEND_BYTES = 4 * 1024 * 1024;
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
// Capture stores sensitive header values as this literal; sending it would be
// guaranteed garbage auth, so such headers are dropped from the resend.
const REDACTED_LITERAL = '«redacted»';

export interface CollectorHandle {
  port: number;
  close(): void;
}

interface MergedRequest {
  id: string;
  [key: string]: unknown;
}

/**
 * Read and JSON-parse a request body, bounded by `cap` bytes. Replies 413 on
 * overflow and 400 on malformed JSON itself; calls `cb` only with valid JSON.
 */
function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cap: number,
  cb: (payload: unknown) => void
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (c: Buffer) => {
    if (tooLarge) return;
    size += c.length;
    if (size > cap) {
      tooLarge = true;
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooLarge) return;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    cb(payload);
  });
  req.on('error', () => {
    /* client vanished mid-send — nothing to clean up */
  });
}

export function startCollector(preferredPort: number): Promise<CollectorHandle> {
  const merged = new Map<string, MergedRequest>();
  const sseClients = new Set<http.ServerResponse>();

  const uiDir = path.join(__dirname, '..', 'ui');
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.json': 'application/json',
  };

  function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
    const clean = urlPath.split('?')[0];
    const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
    const file = path.normalize(path.join(uiDir, rel));
    // Trailing separator: a bare prefix check also matches a sibling like
    // `<uiDir>-secret`, so require the path to live strictly *inside* uiDir.
    if (!file.startsWith(uiDir + path.sep)) return false; // no traversal
    try {
      const content = fs.readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  // Fan a payload out to every live SSE client, pruning any that have gone
  // away. A write to a just-disconnected client can throw; that must never
  // escape into a request handler (record() runs inside /ingest's 'end').
  function broadcast(payload: string): void {
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function record(event: NetbridgeEvent): void {
    const existing = merged.get(event.id) || { id: event.id };
    for (const [k, v] of Object.entries(event)) {
      if (v !== undefined && k !== 'phase') existing[k] = v;
    }
    existing.state =
      event.phase === 'error' ? 'error' : event.phase === 'end' ? 'done' : existing.state || 'pending';
    merged.set(event.id, existing);
    if (merged.size > MAX_EVENTS) {
      const firstKey = merged.keys().next().value;
      if (firstKey) merged.delete(firstKey);
    }

    broadcast(`data: ${JSON.stringify(event)}\n\n`);
  }

  interface ResendSpec {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    bodyEncoding?: 'utf8' | 'base64';
    replayOf?: string;
  }

  // Re-issue a request from the collector process. The capture layer only
  // instruments the app process, so replay events are synthesized here and
  // routed through record() to reach the buffer and the live UI.
  async function executeResend(spec: ResendSpec): Promise<string> {
    const id = nextId();
    const started = Date.now();
    const sendHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.headers)) {
      const lower = k.toLowerCase();
      if (DROP_ON_RESEND.has(lower) || v === REDACTED_LITERAL) continue;
      sendHeaders[lower] = v;
    }
    // undici throws on GET/HEAD bodies.
    const hasBody = spec.body != null && !['GET', 'HEAD'].includes(spec.method);
    record({
      id,
      phase: 'start',
      ts: started,
      pid: process.pid,
      source: 'replay',
      method: spec.method,
      url: spec.url,
      // Re-sanitize for the store: a user-re-entered token goes on the wire
      // but must never sit unredacted in the buffer or the SSE stream.
      reqHeaders: sanitizeHeaders(sendHeaders),
      ...(hasBody ? { reqBody: spec.body, reqBodyEncoding: spec.bodyEncoding ?? 'utf8' } : {}),
      ...(spec.replayOf ? { replayOf: spec.replayOf } : {}),
    } as NetbridgeEvent);
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
        id,
        phase: 'end',
        ts: Date.now(),
        pid: process.pid,
        source: 'replay',
        method: spec.method,
        url: spec.url,
        status: res.status,
        statusText: res.statusText,
        resHeaders: sanitizeHeaders(Object.fromEntries(res.headers)),
        ...(encoded ? { resBody: encoded.body, resBodyEncoding: encoded.encoding } : {}),
        ...(bodyCollector.truncated ? { resBodyTruncated: true } : {}),
        durationMs: Date.now() - started,
      } as NetbridgeEvent);
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      record({
        id,
        phase: 'error',
        ts: Date.now(),
        pid: process.pid,
        source: 'replay',
        method: spec.method,
        url: spec.url,
        error: String(cause?.code || cause?.message || (err as Error)?.message || err),
        durationMs: Date.now() - started,
      } as NetbridgeEvent);
    }
    return id;
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (req.method === 'POST' && url === '/ingest') {
      // Collect raw Buffers (not string concat) so multi-byte utf8 split across
      // chunk boundaries is never corrupted, and so the cap counts real bytes.
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c: Buffer) => {
        if (tooLarge) return;
        size += c.length;
        if (size > MAX_INGEST_BYTES) {
          // Runaway producer: stop buffering, reject, and cut the socket.
          tooLarge = true;
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks).toString('utf8');
        for (const line of body.split('\n')) {
          if (!line.trim()) continue;
          try {
            record(JSON.parse(line) as NetbridgeEvent);
          } catch {
            /* skip malformed lines */
          }
        }
        res.writeHead(204).end();
      });
      // A client abort / socket error must not surface as an uncaught throw.
      req.on('error', () => {
        /* producer vanished mid-send — nothing to clean up */
      });
      return;
    }

    if (req.method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Send backlog as merged snapshots, then stream live events.
      res.write(`event: snapshot\ndata: ${JSON.stringify([...merged.values()])}\n\n`);
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': hb\n\n');
        } catch {
          /* socket died between ticks — cleanup runs on close/error */
        }
      }, 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      };
      req.on('close', cleanup);
      // Without an 'error' listener a late write error would crash the process.
      res.on('error', cleanup);
      return;
    }

    if (req.method === 'GET' && url === '/api/health') {
      // Discovery endpoint: lets the DevTools extension (and scripts) find a
      // running netbridge collector by scanning localhost ports.
      let version = '0.0.0';
      try {
        // package.json ships in the npm tarball next to dist/.
        version = require(path.join(__dirname, '..', 'package.json')).version;
      } catch {
        /* keep default */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'netbridge', version, requests: merged.size }));
      return;
    }

    if (req.method === 'GET' && url === '/api/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...merged.values()]));
      return;
    }

    if (req.method === 'POST' && url === '/api/clear') {
      merged.clear();
      broadcast(`event: clear\ndata: {}\n\n`);
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'POST' && url === '/api/resend') {
      readJsonBody(req, res, MAX_RESEND_BYTES, (payload) => {
        const fail = (code: number, error: string) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error }));
        };
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          fail(400, 'invalid JSON body');
          return;
        }
        const p = payload as Record<string, unknown>;
        const base = p.id != null ? merged.get(String(p.id)) : undefined;
        if (p.id != null && !base) {
          fail(404, `unknown request id: ${String(p.id)}`);
          return;
        }
        const method = String(p.method ?? base?.method ?? '').toUpperCase();
        if (!/^[A-Z][A-Z-]*$/.test(method)) {
          fail(400, 'invalid or missing method');
          return;
        }
        const target = String(p.url ?? base?.url ?? '');
        try {
          const u = new URL(target);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
        } catch {
          fail(400, 'invalid or missing url (http/https only)');
          return;
        }
        const spec: ResendSpec = {
          method,
          url: target,
          headers: (p.headers ?? base?.reqHeaders ?? {}) as Record<string, string>,
          body: p.body !== undefined ? String(p.body) : (base?.reqBody as string | undefined),
          bodyEncoding:
            p.body !== undefined
              ? p.bodyEncoding === 'base64'
                ? 'base64'
                : 'utf8'
              : (base?.reqBodyEncoding as 'utf8' | 'base64' | undefined),
          replayOf: p.id != null ? String(p.id) : undefined,
        };
        // Both success and network failure are recorded entries — reply 200
        // with the settled entry either way so callers get the result inline.
        executeResend(spec)
          .then((newId) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(merged.get(newId) ?? { id: newId }));
          })
          .catch(() => fail(500, 'resend failed'));
      });
      return;
    }

    if (req.method === 'GET') {
      if (serveStatic(url, res)) return;
      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(500).end('netbridge UI not found — was the package built? (pnpm build)');
        return;
      }
    }

    res.writeHead(404).end('not found');
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryListen = (port: number) => {
      attempts += 1;
      // Pair the handlers and detach the loser: a stale 'listening' callback
      // from a failed attempt must never resolve with the busy port number.
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        // Stop before 65536: server.listen() throws a synchronous RangeError on
        // an out-of-range port, which would escape this handler uncaught.
        if (err.code === 'EADDRINUSE' && attempts < 20 && port < 65535) {
          tryListen(port + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        const actualPort =
          address && typeof address === 'object' ? address.port : port;
        resolve({
          port: actualPort,
          close: () => server.close(),
        });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryListen(preferredPort);
  });
}
