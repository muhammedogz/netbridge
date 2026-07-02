/**
 * netbridge collector — runs inside the CLI process.
 *
 * Endpoints:
 *   GET  /              the web UI
 *   GET  /events        SSE stream of capture events (backlog + live)
 *   POST /ingest        NDJSON capture events from preloaded app processes
 *   GET  /api/requests  JSON dump of the merged request table
 *   POST /api/clear     reset the buffer
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { NetbridgeEvent } from './capture/shared';

const MAX_EVENTS = 4000;
// Hard cap on a single /ingest body: a buggy or runaway producer must never be
// able to OOM the collector. Comfortably fits a batch of NDJSON capture events.
const MAX_INGEST_BYTES = 16 * 1024 * 1024;

export interface CollectorHandle {
  port: number;
  close(): void;
}

interface MergedRequest {
  id: string;
  [key: string]: unknown;
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
