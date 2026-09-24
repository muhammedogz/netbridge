/** Server-sent events: the live feed the web UI subscribes to. */
import type * as http from 'http';
import type { Entry } from '../protocol';
import { drained } from './http-util';

const HEARTBEAT_MS = 15_000;
/** Target size of one snapshot event; many small ones instead of one giant. */
const SNAPSHOT_CHUNK_CHARS = 1024 * 1024;
/**
 * Most data a client may leave unread. A tab that stops reading (stalled,
 * frozen, a dead socket not yet noticed) would otherwise make the collector
 * buffer every event for it. Dropped clients reconnect on their own
 * (EventSource retries) and resync from a fresh snapshot.
 */
const MAX_UNREAD_BYTES = 64 * 1024 * 1024;

interface Client {
  res: http.ServerResponse;
  /** False while the snapshot is still being written. */
  ready: boolean;
  /** Live events that arrived during the snapshot, sent right after it. */
  pending: string[];
  pendingChars: number;
}

export class SseHub {
  private clients = new Set<Client>();

  /**
   * Open a stream: the backlog as a series of `snapshot` events (the UI merges
   * each one), then live events in order.
   */
  subscribe(req: http.IncomingMessage, res: http.ServerResponse, backlog: Entry[]): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const client: Client = { res, ready: false, pending: [], pendingChars: 0 };
    this.clients.add(client);
    const heartbeat = setInterval(() => {
      if (client.ready) this.write(client, ': hb\n\n');
    }, HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    };
    req.on('close', cleanup);
    // Without an 'error' listener a late write error would crash the process.
    res.on('error', cleanup);
    this.sendSnapshot(client, backlog).catch(() => this.drop(client));
  }

  /** A capture event, as the UI's default `message` event. */
  event(data: unknown): void {
    this.broadcast(`data: ${JSON.stringify(data)}\n\n`);
  }

  /** A named event, such as `clear`. */
  named(name: string, data: unknown): void {
    this.broadcast(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private async sendSnapshot(client: Client, backlog: Entry[]): Promise<void> {
    const { res } = client;
    let batch: string[] = [];
    let chars = 0;
    const flush = async () => {
      // Always at least one snapshot event, so the UI knows it is in sync.
      const ok = res.write(`event: snapshot\ndata: [${batch.join(',')}]\n\n`);
      batch = [];
      chars = 0;
      if (!ok) await drained(res);
    };
    for (const entry of backlog) {
      let json: string;
      try {
        json = JSON.stringify(entry);
      } catch {
        continue;
      }
      batch.push(json);
      chars += json.length;
      if (chars >= SNAPSHOT_CHUNK_CHARS) await flush();
      if (res.destroyed) return;
    }
    if (batch.length > 0 || backlog.length === 0) await flush();
    for (const payload of client.pending) this.write(client, payload);
    client.pending = [];
    client.pendingChars = 0;
    client.ready = true;
  }

  // Fan a payload out to every live client, pruning any that have gone away.
  // A write to a just-disconnected client can throw; that must never escape
  // into a request handler (broadcasts run inside /ingest).
  private broadcast(payload: string): void {
    for (const client of this.clients) {
      if (client.ready) {
        this.write(client, payload);
      } else {
        client.pending.push(payload);
        client.pendingChars += payload.length;
        if (client.pendingChars > MAX_UNREAD_BYTES) this.drop(client);
      }
    }
  }

  private write(client: Client, payload: string): void {
    const { res } = client;
    if (res.writableEnded || res.destroyed || res.writableLength > MAX_UNREAD_BYTES) {
      this.drop(client);
      return;
    }
    try {
      res.write(payload);
    } catch {
      this.drop(client);
    }
  }

  private drop(client: Client): void {
    this.clients.delete(client);
    client.pending = [];
    client.res.destroy();
  }
}
