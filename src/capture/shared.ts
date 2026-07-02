/**
 * Shared types, config, redaction and event transport for the capture layer.
 *
 * IMPORTANT: this module must save pristine references to anything it needs
 * (http.request) BEFORE the http wrapper patches them, so that netbridge's own
 * telemetry traffic is never captured (no feedback loops).
 */
import * as http from 'http';
import * as zlib from 'zlib';

// Pristine reference, captured at module load (before any patching).
const pristineHttpRequest = http.request;

export interface NetbridgeEvent {
  /** Unique id shared between the start and end phase of one request. */
  id: string;
  phase: 'start' | 'end' | 'error';
  ts: number;
  pid: number;
  source: 'fetch' | 'http';
  method: string;
  url: string;
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  reqBodyEncoding?: 'utf8' | 'base64';
  reqBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  resBody?: string;
  resBodyEncoding?: 'utf8' | 'base64';
  resBodyTruncated?: boolean;
  durationMs?: number;
  error?: string;
}

export const config = {
  port: Number(process.env.NETBRIDGE_PORT || 0),
  bodyLimit: Number(process.env.NETBRIDGE_BODY_LIMIT || 256 * 1024),
  redact: process.env.NETBRIDGE_REDACT !== '0',
};

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `${process.pid}-${Date.now().toString(36)}-${counter}`;
}

const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
]);

export function sanitizeHeaders(
  input: Record<string, unknown> | undefined | null
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (config.redact && REDACTED_HEADERS.has(lower)) {
      out[lower] = '«redacted»';
    } else {
      out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return out;
}

/** Decompress a captured raw body according to content-encoding (best effort). */
export function decompressBody(raw: Buffer, contentEncoding?: string): Buffer {
  const enc = (contentEncoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw);
    if (enc === 'deflate') return zlib.inflateSync(raw);
    if (enc === 'br') return zlib.brotliDecompressSync(raw);
    if (enc === 'zstd' && typeof (zlib as any).zstdDecompressSync === 'function') {
      return (zlib as any).zstdDecompressSync(raw);
    }
  } catch {
    // fall through: return raw bytes, encoder below will base64 them
  }
  return raw;
}

/** Encode a body buffer for transport: utf8 when printable, base64 otherwise. */
export function encodeBody(buf: Buffer): { body: string; encoding: 'utf8' | 'base64' } {
  const text = buf.toString('utf8');
  // Heuristic: replacement chars or NUL bytes mean it is not valid utf8 text.
  if (text.includes('\uFFFD') || text.includes('\u0000')) {
    return { body: buf.toString('base64'), encoding: 'base64' };
  }
  return { body: text, encoding: 'utf8' };
}

/** Collects body chunks up to the configured limit. */
export class BodyCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: unknown, encoding?: string): void {
    if (this.size >= config.bodyLimit) {
      this.truncated = true;
      return;
    }
    let buf: Buffer | null = null;
    if (Buffer.isBuffer(chunk)) buf = chunk;
    else if (typeof chunk === 'string') {
      // Honor the stream write encoding (hex/base64/latin1/…) so a non-utf8
      // string body is captured as its real bytes instead of mojibake.
      const enc = (encoding && Buffer.isEncoding(encoding) ? encoding : 'utf8') as BufferEncoding;
      buf = Buffer.from(chunk, enc);
    } else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk);
    if (!buf) return;
    const remaining = config.bodyLimit - this.size;
    if (buf.length > remaining) {
      this.chunks.push(buf.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
    } else {
      this.chunks.push(buf);
      this.size += buf.length;
    }
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get isEmpty(): boolean {
    return this.size === 0 && !this.truncated;
  }
}

/** True for traffic addressed to the netbridge collector itself. */
export function isOwnTraffic(url: string): boolean {
  if (!config.port) return false;
  return (
    url.startsWith(`http://127.0.0.1:${config.port}`) ||
    url.startsWith(`http://localhost:${config.port}`)
  );
}

// ---------------------------------------------------------------------------
// Transport: fire-and-forget NDJSON POSTs to the collector, using the pristine
// (unpatched) http.request so telemetry is invisible to the capture layer.
// ---------------------------------------------------------------------------

// Bound the in-memory backlog: if the collector is gone or the host event loop
// is starved (so the flush timer can't run), the queue must not grow without
// limit and OOM the host app. flush() drains fully every ~20ms in the happy
// path, so this cap is only ever hit under genuine backpressure.
const MAX_QUEUE = 10_000;
let queue: NetbridgeEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;

// Keep each POST well under the collector's ingest cap (16MB): a burst of
// big-bodied events batched into one flush must never produce a payload the
// collector rejects wholesale (413 → silent loss of the entire batch).
const MAX_POST_BYTES = 4 * 1024 * 1024;

function post(payload: string): void {
  try {
    const req = pristineHttpRequest(
      {
        host: '127.0.0.1',
        port: config.port,
        path: '/ingest',
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {
      /* collector gone — drop silently */
    });
    req.end(payload);
  } catch {
    /* never break the host app */
  }
}

function flush(): void {
  flushTimer = null;
  if (queue.length === 0 || !config.port) return;
  const batch = queue;
  queue = [];
  // Chunk by byte size, not event count: one event is bounded (~2× bodyLimit
  // base64-inflated) but a batch of many such events can exceed the ingest cap.
  let lines: string[] = [];
  let bytes = 0;
  for (const e of batch) {
    const line = JSON.stringify(e);
    if (bytes > 0 && bytes + line.length + 1 > MAX_POST_BYTES) {
      post(lines.join('\n'));
      lines = [];
      bytes = 0;
    }
    lines.push(line);
    bytes += line.length + 1;
  }
  if (lines.length > 0) post(lines.join('\n'));
}

export function emit(event: NetbridgeEvent): void {
  if (!config.port) return;
  // Drop under sustained backpressure rather than grow unbounded. Debugging
  // telemetry must never be the reason the host app runs out of memory.
  if (queue.length >= MAX_QUEUE) return;
  queue.push(event);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 20);
    // Never keep the host process alive because of telemetry.
    flushTimer.unref?.();
  }
}

/** Flush synchronously-ish on process exit so trailing events are not lost. */
process.on('beforeExit', flush);
