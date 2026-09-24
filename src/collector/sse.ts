/** Server-sent events: the live feed the web UI subscribes to. */
import type * as http from 'http';
import type { Entry } from '../protocol';

const HEARTBEAT_MS = 15_000;

export class SseHub {
  private clients = new Set<http.ServerResponse>();

  /** Open a stream: the backlog as one snapshot event, then live events. */
  subscribe(req: http.IncomingMessage, res: http.ServerResponse, backlog: Entry[]): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(backlog)}\n\n`);
    this.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        /* socket died between ticks: cleanup runs on close/error */
      }
    }, HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    req.on('close', cleanup);
    // Without an 'error' listener a late write error would crash the process.
    res.on('error', cleanup);
  }

  /** A capture event, as the UI's default `message` event. */
  event(data: unknown): void {
    this.broadcast(`data: ${JSON.stringify(data)}\n\n`);
  }

  /** A named event, such as `clear`. */
  named(name: string, data: unknown): void {
    this.broadcast(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Fan a payload out to every live client, pruning any that have gone away.
  // A write to a just-disconnected client can throw; that must never escape
  // into a request handler (broadcasts run inside /ingest).
  private broadcast(payload: string): void {
    for (const client of this.clients) {
      if (client.writableEnded || client.destroyed) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
