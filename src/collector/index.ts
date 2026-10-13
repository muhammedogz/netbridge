/**
 * netbridge collector: runs inside the CLI process.
 *
 * Endpoints:
 *   GET  /              the web UI
 *   GET  /events        SSE stream of capture events (backlog + live)
 *   POST /ingest        NDJSON capture events from preloaded app processes
 *   GET  /api/health    discovery: { app: "netbridge", version, requests, ports }
 *   GET  /api/requests  JSON dump of the merged request table; optional query:
 *                       parent=<id> source=<s> since=<ms> limit=<n> summary=1
 *   GET  /api/requests/<id>  one entry
 *   GET  /api/config    view settings for the UI (--exclude patterns)
 *   POST /api/clear     reset the buffer
 *   POST /api/resend    re-issue a captured (optionally edited) request
 *   GET/PUT/POST /api/mocks, DELETE /api/mocks/<id>   mock rules
 *   GET  /api/mocks/stream   rules feed for the app processes (token)
 *   *    /__mock/<id>   answers an http-module call a rule mocks (token)
 */
import * as http from 'http';
import { summarize } from '../protocol';
import type { Entry, NetbridgeEvent } from '../protocol';
import { refusal, tokenMatches } from './guard';
import { jsonError, readBody, readJson, sendJson, streamJsonArray } from './http-util';
import { packageVersion } from '../version';
import { MockStore } from './mocks';
import { executeResend, parseResend } from './resend';
import { SseHub } from './sse';
import { serveStatic } from './static';
import { RequestStore, isEvent, isListen } from './store';

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
  /** Secret the preloaded processes send with /ingest (x-netbridge-token). */
  token: string;
  /** Budget for retained bodies and headers, see DEFAULT_BUFFER_LIMIT. */
  bufferLimit?: number;
  /** Extra host names served besides loopback (NETBRIDGE_ALLOWED_HOSTS). */
  allowedHosts?: ReadonlySet<string>;
  /** Mock rules (and the --mocks file they are saved to). */
  mocks?: MockStore;
}

/** Whether a process is still running (a port it reported may be stale). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The /api/requests query: which entries, and whether to drop bodies. */
function selectEntries(all: Entry[], query: URLSearchParams): Entry[] {
  let list = all;
  const parent = query.get('parent');
  const source = query.get('source');
  const since = Number(query.get('since'));
  if (parent) list = list.filter((e) => e.parentId === parent);
  if (source) list = list.filter((e) => e.source === source);
  if (since > 0) list = list.filter((e) => e.ts >= since);
  const limit = Number(query.get('limit'));
  if (limit > 0 && list.length > limit) list = list.slice(-limit);
  return list;
}

export function startCollector(preferredPort: number, options: CollectorOptions): Promise<CollectorHandle> {
  const store = new RequestStore(options.bufferLimit);
  const hub = new SseHub();
  const mocks = options.mocks ?? new MockStore();
  mocks.onChange((rules) => hub.named('mocks', rules));
  // Ports the app processes listen on, by port: the pid that reported it.
  const ports = new Map<number, number>();
  const version = packageVersion();
  // startedAt tells runs apart: the UI merges the exclusions into its saved
  // filter once per run, so a reload doesn't undo the user's edits.
  const viewConfig = JSON.stringify({
    exclude: options.exclude ?? [],
    startedAt: Date.now(),
    bufferLimit: store.maxBytes,
    version,
  });
  // The bound port, for the Origin check; set once listening.
  let listeningPort = 0;

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
      else if (isListen(event)) ports.set(event.port, event.pid);
    }
    res.writeHead(204).end();
  }

  async function resend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // This endpoint makes the collector issue outbound requests. On top of the
    // Origin guard every POST passes, require application/json: cross-origin
    // that makes a preflighted request, and the preflight fails since we send
    // no CORS headers. curl/scripts without an Origin just set the header.
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

  async function editMocks(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Same reasoning as /api/resend: JSON only, so a cross-origin page can't
    // send it without a preflight that fails.
    const ctype = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ctype.trim())) {
      return jsonError(res, 415, 'content-type must be application/json');
    }
    const payload = await readJson(req, res, MAX_RESEND_BYTES);
    if (payload === undefined) return;
    const result = req.method === 'PUT' ? mocks.replace(payload) : mocks.upsert(payload);
    if (typeof result === 'string') return jsonError(res, 400, result);
    sendJson(res, 200, result);
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method;
    const { pathname, searchParams } = new URL(url, 'http://collector');

    const refused = refusal(req, listeningPort, options.token, options.allowedHosts);
    if (refused) return jsonError(res, refused.status, refused.error);

    // Only the app processes netbridge launched hold the token.
    if (pathname === '/api/mocks/stream' || pathname.startsWith('/__mock/')) {
      if (!tokenMatches(req.headers['x-netbridge-token'], options.token)) {
        return jsonError(res, 401, 'missing or invalid token');
      }
      if (pathname === '/api/mocks/stream') return mocks.subscribe(req, res);
      return mocks.serve(decodeURIComponent(pathname.slice('/__mock/'.length)), req, res);
    }

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
      const live = [...ports].filter(([, pid]) => alive(pid)).map(([port]) => port);
      return sendJson(res, 200, { app: 'netbridge', version, requests: store.size, ports: live });
    }
    if (method === 'GET' && pathname === '/api/requests') {
      const list = selectEntries(store.values(), searchParams);
      return streamJsonArray(res, searchParams.get('summary') === '1' ? list.map(summarize) : list);
    }
    if (method === 'GET' && pathname.startsWith('/api/requests/')) {
      const entry = store.get(decodeURIComponent(pathname.slice('/api/requests/'.length)));
      return entry ? sendJson(res, 200, entry) : jsonError(res, 404, 'unknown request id');
    }
    if (pathname === '/api/mocks') {
      if (method === 'GET') return sendJson(res, 200, mocks.list());
      if (method === 'PUT' || method === 'POST') return editMocks(req, res);
    }
    if (method === 'DELETE' && pathname.startsWith('/api/mocks/')) {
      const removed = mocks.remove(decodeURIComponent(pathname.slice('/api/mocks/'.length)));
      return removed ? void res.writeHead(204).end() : jsonError(res, 404, 'unknown mock rule');
    }
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
        listeningPort = address && typeof address === 'object' ? address.port : port;
        resolve({ port: listeningPort, close: () => server.close() });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryListen(preferredPort);
  });
}
