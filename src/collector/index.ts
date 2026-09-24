/**
 * netbridge collector: runs inside the CLI process.
 *
 * Endpoints:
 *   GET  /              the web UI
 *   GET  /events        SSE stream of capture events (backlog + live)
 *   POST /ingest        NDJSON capture events from preloaded app processes
 *   GET  /api/health    discovery: { app: "netbridge", version, requests }
 *   GET  /api/requests  JSON dump of the merged request table
 *   GET  /api/config    view settings for the UI (--exclude patterns)
 *   POST /api/clear     reset the buffer
 *   POST /api/resend    re-issue a captured (optionally edited) request
 */
import * as http from 'http';
import * as path from 'path';
import type { NetbridgeEvent } from '../protocol';
import { jsonError, readBody, readJson, sendJson } from './http-util';
import { executeResend, parseResend } from './resend';
import { SseHub } from './sse';
import { serveStatic } from './static';
import { RequestStore, isEvent } from './store';

// Hard cap on a single /ingest body: a buggy or runaway producer must never be
// able to OOM the collector. Comfortably fits a batch of NDJSON capture events.
const MAX_INGEST_BYTES = 16 * 1024 * 1024;
// Cap on a /api/resend payload: an edited body plus headers fits comfortably.
const MAX_RESEND_BYTES = 4 * 1024 * 1024;

export interface CollectorHandle {
  port: number;
  close(): void;
}

export interface CollectorOptions {
  /** `--exclude` patterns the UI seeds its filter box with (view only). */
  exclude?: string[];
}

function packageVersion(): string {
  try {
    // package.json ships in the npm tarball next to dist/.
    return require(path.join(__dirname, '..', '..', 'package.json')).version;
  } catch {
    return '0.0.0';
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false; // a malformed Origin stays non-local
  }
}

export function startCollector(preferredPort: number, options: CollectorOptions = {}): Promise<CollectorHandle> {
  const store = new RequestStore();
  const hub = new SseHub();
  const version = packageVersion();
  // startedAt tells runs apart: the UI merges the exclusions into its saved
  // filter once per run, so a reload doesn't undo the user's edits.
  const viewConfig = JSON.stringify({ exclude: options.exclude ?? [], startedAt: Date.now() });

  function record(event: NetbridgeEvent): void {
    store.record(event);
    hub.event(event);
  }

  async function ingest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req, res, MAX_INGEST_BYTES);
    if (!body) return;
    for (const line of body.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }
      if (isEvent(event)) record(event);
    }
    res.writeHead(204).end();
  }

  async function resend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CSRF guard. This endpoint makes the collector issue outbound requests,
    // so a drive-by page must not be able to trigger it. Two layers:
    // - a present Origin header must be local (the UI is same-origin; a
    //   browser always attaches Origin to cross-site POSTs);
    // - the content-type must be application/json, which cross-origin makes
    //   a preflighted request; the preflight fails since we send no CORS
    //   headers. curl/scripts without an Origin just set the header.
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) return jsonError(res, 403, 'cross-origin resend rejected');
    const ctype = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ctype.trim())) {
      return jsonError(res, 415, 'content-type must be application/json');
    }
    const payload = await readJson(req, res, MAX_RESEND_BYTES);
    if (payload === undefined) return;
    const parsed = parseResend(payload, (id) => store.get(id));
    if ('error' in parsed) return jsonError(res, parsed.status, parsed.error);
    // Both success and network failure are recorded entries: reply 200 with
    // the settled entry either way so callers get the result inline.
    const id = await executeResend(parsed.spec, record);
    sendJson(res, 200, store.get(id) ?? { id });
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method;

    if (method === 'POST' && url === '/ingest') return ingest(req, res);
    if (method === 'POST' && url === '/api/resend') return resend(req, res);
    if (method === 'POST' && url === '/api/clear') {
      store.clear();
      hub.named('clear', {});
      res.writeHead(204).end();
      return;
    }
    if (method === 'GET' && url === '/events') return hub.subscribe(req, res, store.values());
    if (method === 'GET' && url === '/api/health') {
      return sendJson(res, 200, { app: 'netbridge', version, requests: store.size });
    }
    if (method === 'GET' && url === '/api/requests') return sendJson(res, 200, store.values());
    if (method === 'GET' && url === '/api/config') return sendJson(res, 200, viewConfig);
    if (method === 'GET') {
      if (serveStatic(url, res)) return;
      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(500).end('netbridge UI not found. Was the package built? (pnpm build)');
        return;
      }
    }
    res.writeHead(404).end('not found');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) jsonError(res, 500, 'internal error');
      else res.destroy();
    });
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
        const actualPort = address && typeof address === 'object' ? address.port : port;
        resolve({ port: actualPort, close: () => server.close() });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryListen(preferredPort);
  });
}
