/**
 * The wire contract between the capture layer, the collector and the web UI.
 *
 * Imported by both the Node side (src/) and the browser bundle (ui-src/), so
 * it must stay free of Node APIs and runtime dependencies.
 */

export type Source = 'fetch' | 'http' | 'replay';
export type BodyEncoding = 'utf8' | 'base64';
export type EntryState = 'pending' | 'done' | 'error';

/** One capture event. `start`, then `end` or `error`, share an id. */
export interface NetbridgeEvent {
  /** Unique id shared between the start and end phase of one request. */
  id: string;
  phase: 'start' | 'end' | 'error';
  ts: number;
  pid: number;
  source: Source;
  method: string;
  url: string;
  /** For replay entries: the id of the original captured request. */
  replayOf?: string;
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  reqBodyEncoding?: BodyEncoding;
  reqBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  resBody?: string;
  resBodyEncoding?: BodyEncoding;
  resBodyTruncated?: boolean;
  durationMs?: number;
  error?: string;
}

/** A request as the collector stores it: its events merged, plus a state. */
export type Entry = Omit<NetbridgeEvent, 'phase'> & { state: EntryState };

/** GET /api/config: CLI options that shape the UI's starting view. */
export interface ViewConfig {
  /** `--exclude` patterns to seed the filter box with. */
  exclude: string[];
  /** When the collector started; tells netbridge runs apart. */
  startedAt: number;
  /** The collector's buffer budget (see DEFAULT_BUFFER_LIMIT). */
  bufferLimit?: number;
}

/** Header values the capture layer hides are replaced with this literal. */
export const REDACTED = '«redacted»';

/** Most requests the collector (and the UI) keep; the oldest go first. */
export const MAX_ENTRIES = 4000;

/**
 * Default budget for the bodies and headers kept, in characters (about bytes
 * for text; NETBRIDGE_BUFFER_LIMIT overrides it). Past it the oldest entries
 * go, so a session full of large bodies stays bounded in both the collector
 * and the browser tab.
 */
export const DEFAULT_BUFFER_LIMIT = 256 * 1024 * 1024;

/** Every field an event may carry. Anything else on the wire is ignored. */
const EVENT_FIELDS: readonly (keyof Entry)[] = [
  'id',
  'ts',
  'pid',
  'source',
  'method',
  'url',
  'replayOf',
  'reqHeaders',
  'reqBody',
  'reqBodyEncoding',
  'reqBodyTruncated',
  'status',
  'statusText',
  'resHeaders',
  'resBody',
  'resBodyEncoding',
  'resBodyTruncated',
  'durationMs',
  'error',
];

/**
 * Fold an event into the entry for its request (created when `existing` is
 * undefined). Only known fields are copied, so a malformed or hostile event
 * cannot plant arbitrary keys (or `__proto__`) on the entry. Mutates and
 * returns `existing` when given.
 */
export function mergeEvent<T extends { id: string; state?: EntryState }>(
  existing: T | undefined,
  event: Partial<NetbridgeEvent> & { id: string }
): T {
  const target = (existing ?? { id: event.id }) as T;
  const fields = target as unknown as Record<string, unknown>;
  for (const key of EVENT_FIELDS) {
    const value = event[key as keyof NetbridgeEvent];
    if (value !== undefined) fields[key] = value;
  }
  target.state =
    event.phase === 'error' ? 'error' : event.phase === 'end' ? 'done' : target.state || 'pending';
  return target;
}

/** Approximate retained size of an entry: its bodies, headers and url. */
export function entrySize(e: Partial<Entry>): number {
  let n = (e.url?.length ?? 0) + (e.reqBody?.length ?? 0) + (e.resBody?.length ?? 0) + (e.error?.length ?? 0);
  for (const headers of [e.reqHeaders, e.resHeaders]) {
    if (!headers) continue;
    for (const k in headers) n += k.length + String(headers[k]).length;
  }
  return n + 200; // fixed fields and bookkeeping
}
