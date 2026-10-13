/**
 * The wire contract between the capture layer, the collector and the web UI.
 *
 * Imported by both the Node side (src/) and the browser bundle (ui-src/), so
 * it must stay free of Node APIs and runtime dependencies.
 */

/**
 * Where an entry came from: an outbound call through fetch, the http module or
 * undici's own API, a replay sent by the collector, or an inbound request the
 * app's server received (recorded once it makes outbound calls of its own).
 */
export type Source = 'fetch' | 'http' | 'undici' | 'replay' | 'inbound';
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
  /** The inbound request whose handling made this call. */
  parentId?: string;
  /** The mock rule that answered (or delayed, or failed) this call. */
  mocked?: string;
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
  /** The netbridge version serving the UI. */
  version?: string;
}

/** GET /api/health. */
export interface Health {
  app: 'netbridge';
  version: string;
  requests: number;
  /** Ports the captured app processes listen on; tells collectors apart. */
  ports?: number[];
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
  'parentId',
  'mocked',
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

/** An entry without its headers and bodies: what lists and the overlay need. */
export type EntrySummary = Pick<
  Entry,
  'id' | 'ts' | 'pid' | 'source' | 'method' | 'url' | 'state' | 'status' | 'statusText' | 'durationMs' | 'error' | 'parentId' | 'mocked' | 'replayOf'
> & { resBodySize?: number; /** See callKey(). */ key: string };

export function summarize(e: Entry): EntrySummary {
  return {
    id: e.id,
    ts: e.ts,
    pid: e.pid,
    source: e.source,
    method: e.method,
    url: e.url,
    state: e.state,
    status: e.status,
    statusText: e.statusText,
    durationMs: e.durationMs,
    error: e.error,
    parentId: e.parentId,
    mocked: e.mocked,
    replayOf: e.replayOf,
    resBodySize:
      e.resBody == null ? undefined : e.resBodyEncoding === 'base64' ? Math.floor((e.resBody.length * 3) / 4) : e.resBody.length,
    key: callKey(e),
  };
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

// ---------------------------------------------------------------------------
// Mock rules: matched in the app process, edited in the UI and over the API.
// ---------------------------------------------------------------------------

/** A canned response. */
export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: BodyEncoding;
}

/**
 * One mock rule. A matching call waits `delayMs`, then gets `response`, or
 * fails like a network error when `fail` is set, or else goes out as usual
 * (a delay-only rule).
 */
export interface MockRule {
  id: string;
  enabled: boolean;
  /** Upper-case method; empty matches any. */
  method: string;
  /** A url substring, or a pattern where `*` matches anything. */
  url: string;
  delayMs?: number;
  response?: MockResponse;
  /** Error message for a simulated network failure. */
  fail?: string;
}

const patterns = new Map<string, RegExp>();

/** The url pattern as a RegExp: `*` is a wildcard, the rest is literal. */
function urlPattern(pattern: string): RegExp {
  let re = patterns.get(pattern);
  if (!re) {
    const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    re = new RegExp(`^${escaped.join('.*')}$`, 'i');
    if (patterns.size > 200) patterns.clear();
    patterns.set(pattern, re);
  }
  return re;
}

/** True when `rule` applies to a call. Patterns without `*` match a substring. */
export function mockMatches(rule: MockRule, method: string, url: string): boolean {
  if (!rule.enabled || !rule.url) return false;
  if (rule.method && rule.method !== method.toUpperCase()) return false;
  if (!rule.url.includes('*')) return url.toLowerCase().includes(rule.url.toLowerCase());
  return urlPattern(rule.url).test(url);
}

/** The first enabled rule that applies to a call. */
export function findMock(rules: readonly MockRule[], method: string, url: string): MockRule | undefined {
  for (const rule of rules) if (mockMatches(rule, method, url)) return rule;
  return undefined;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FRAMING_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

/**
 * Validate a rule as written in a mocks file or sent to the API. Missing
 * fields get defaults (enabled, any method); anything malformed is an error
 * message, not a half-working rule.
 */
export function normalizeMockRule(raw: unknown, fallbackId: string): MockRule | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'a rule must be an object';
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url) return 'url is required (a substring, or a pattern with *)';
  const method = typeof r.method === 'string' ? r.method.trim().toUpperCase() : '';
  if (method && method !== '*' && !/^[A-Z][A-Z-]*$/.test(method)) return `invalid method: ${method}`;
  const rule: MockRule = {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : fallbackId,
    enabled: r.enabled !== false,
    method: method === '*' ? '' : method,
    url,
  };
  if (r.delayMs != null) {
    const ms = Number(r.delayMs);
    if (!Number.isFinite(ms) || ms < 0 || ms > 120_000) return 'delayMs must be between 0 and 120000';
    if (ms > 0) rule.delayMs = Math.round(ms);
  }
  if (r.fail != null && r.fail !== false) {
    rule.fail = typeof r.fail === 'string' && r.fail.trim() ? r.fail.trim() : 'mocked network failure';
  }
  if (r.response != null) {
    if (rule.fail) return 'a rule either responds or fails, not both';
    const res = r.response as Record<string, unknown>;
    if (typeof res !== 'object' || Array.isArray(res)) return 'response must be an object';
    const status = Number(res.status ?? 200);
    if (!Number.isInteger(status) || status < 200 || status > 599) return 'response.status must be 200–599';
    const headers: Record<string, string> = {};
    if (res.headers != null) {
      if (typeof res.headers !== 'object' || Array.isArray(res.headers)) return 'response.headers must be an object';
      for (const [k, v] of Object.entries(res.headers as Record<string, unknown>)) {
        if (!HEADER_NAME.test(k)) return `invalid header name: ${JSON.stringify(k)}`;
        const value = String(v);
        // What Node and fetch accept in a header value: tab, printable
        // ASCII and Latin-1. Anything else would throw when sent.
        if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) return `invalid header value for ${JSON.stringify(k)}`;
        // The body is stored decoded and sent as is: framing headers copied
        // from a captured response would describe bytes that aren't sent.
        if (FRAMING_HEADERS.has(k.toLowerCase())) continue;
        headers[k.toLowerCase()] = value;
      }
    }
    let body: string | undefined;
    if (res.body != null) {
      // A JSON value is written as a string of JSON: the file stays readable.
      body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      if (typeof res.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
    }
    rule.response = { status, headers };
    if (body !== undefined) {
      rule.response.body = body;
      if (res.bodyEncoding === 'base64') rule.response.bodyEncoding = 'base64';
    }
  }
  return rule;
}

/** Normalize a list of rules; the first malformed one is reported. */
export function normalizeMockRules(raw: unknown): MockRule[] | string {
  if (!Array.isArray(raw)) return 'mock rules must be a JSON array';
  const out: MockRule[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const rule = normalizeMockRule(raw[i], `m${i + 1}`);
    if (typeof rule === 'string') return `rule ${i + 1}: ${rule}`;
    while (ids.has(rule.id)) rule.id += '-';
    ids.add(rule.id);
    out.push(rule);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call trees: the outbound calls one inbound request made.
// ---------------------------------------------------------------------------

/** FNV-1a: a short, stable fingerprint of a request body. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * What makes two calls the same call: method, url and request body. The body
 * counts, so GraphQL-style POSTs to one endpoint aren't all "duplicates".
 */
export function callKey(e: Pick<Entry, 'method' | 'url'> & { reqBody?: string }): string {
  return `${e.method} ${e.url}${e.reqBody ? ` #${fingerprint(e.reqBody)}` : ''}`;
}

/** How many times each call key occurs, for keys that occur more than once. */
export function duplicateCounts(calls: readonly { key: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  for (const [k, n] of counts) if (n < 2) counts.delete(k);
  return counts;
}

/**
 * When a request started. An entry's `ts` is the time of its latest event:
 * the start while pending, the end once settled (minus the duration).
 */
export function startedAt(e: Pick<Entry, 'ts' | 'durationMs' | 'state'>): number {
  return e.state === 'pending' || e.durationMs == null ? e.ts : e.ts - e.durationMs;
}

/**
 * How far a call may seem to overlap the next one and still count as having
 * come first. Its recorded end trails the moment the app got the body (the
 * capture reads its own copy, and the app may start its next call first): a
 * few ms, growing to about a tenth of the call on a loaded machine. Calls
 * that really run in parallel start together, within the first half of the
 * shorter one, so the window stays within the second half of a short call.
 */
function stepSlack(durationMs: number): number {
  return Math.max(2, durationMs * 0.25, Math.min(10, durationMs * 0.5));
}

/**
 * Sequential steps: runs of calls that overlap in time. Five calls in five
 * steps waited on each other; five in one step ran in parallel. A pending
 * call counts as still running.
 */
export function callSteps(calls: readonly Pick<Entry, 'ts' | 'durationMs' | 'state'>[]): number {
  const spans = calls
    .map((c) => {
      const start = startedAt(c);
      return { start, end: c.state === 'pending' ? Number.POSITIVE_INFINITY : start + (c.durationMs ?? 0) };
    })
    .sort((a, b) => a.start - b.start);
  let steps = 0;
  let end = Number.NEGATIVE_INFINITY;
  let slack = 0;
  for (const s of spans) {
    // A call recorded as ending a moment after the next one starts still
    // came first (see stepSlack).
    if (s.start >= end - slack) steps += 1;
    if (s.end > end) {
      end = s.end;
      slack = stepSlack(s.end - s.start);
    }
  }
  return steps;
}
