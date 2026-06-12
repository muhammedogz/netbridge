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

export interface CollectorHandle {
  port: number;
  close(): void;
}

interface MergedRequest {
  id: string;
  [key: string]: unknown;
}

export function startCollector(preferredPort: number): Promise<CollectorHandle> {
  const events: NetbridgeEvent[] = [];
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
    if (!file.startsWith(uiDir)) return false; // no traversal
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

  function record(event: NetbridgeEvent): void {
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

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

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (req.method === 'POST' && url === '/ingest') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
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
      const heartbeat = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
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
      events.length = 0;
      merged.clear();
      const payload = `event: clear\ndata: {}\n\n`;
      for (const client of sseClients) client.write(payload);
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
        if (err.code === 'EADDRINUSE' && attempts < 20) {
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
