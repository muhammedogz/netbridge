/**
 * Row filtering for the request table: the header filter box and the chips.
 *
 * The filter box takes whitespace-separated terms that must all hold, in the
 * style of the Chrome DevTools network filter:
 *
 *   order_id             free text: url, method, status, source, headers, utf8 bodies
 *   -order_id            a leading "-" hides whatever the term matches
 *   host:localhost:4318  keyed: url, host, path, method, status, source
 *
 * Matching is case-insensitive. A term with an unknown key is plain text, so
 * `localhost:4318` needs no escaping. No input can throw, and terms still
 * being typed ("-", "host:") are ignored rather than blanking the table.
 *
 * No runtime imports: test/filter.test.mjs loads this file on its own.
 */
import type { CapturedRequest } from './types';

export type FilterKey = 'url' | 'host' | 'path' | 'method' | 'status' | 'source';

export interface FilterTerm {
  /** Attribute the term is scoped to; null for free text. */
  key: FilterKey | null;
  /** Lower-cased text to look for. */
  value: string;
  /** Leading "-": the row must NOT match. */
  negate: boolean;
}

// A Map rather than an object literal, so `constructor:x` can never resolve
// to a key through Object.prototype.
const KEYS = new Map<string, FilterKey>([
  ['url', 'url'],
  ['host', 'host'],
  ['domain', 'host'], // Chrome DevTools spelling
  ['path', 'path'],
  ['method', 'method'],
  ['status', 'status'],
  ['status-code', 'status'], // Chrome DevTools spelling
  ['source', 'source'],
]);

export function parseFilter(query: string): FilterTerm[] {
  const terms: FilterTerm[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const negate = raw.startsWith('-');
    const token = negate ? raw.slice(1) : raw;
    const colon = token.indexOf(':');
    const key = colon > 0 ? KEYS.get(token.slice(0, colon)) : undefined;
    const value = key ? token.slice(colon + 1) : token;
    if (value) terms.push({ key: key ?? null, value, negate });
  }
  // Free text last: it scans headers and bodies, so the cheap keyed terms get
  // the chance to reject a row first.
  return terms.sort((a, b) => Number(a.key === null) - Number(b.key === null));
}

/** One lower-cased searchable string per row: metadata, headers, utf8 bodies. */
function haystack(r: CapturedRequest): string {
  let hay = `${r.method} ${r.url} ${r.status || ''} ${r.source || ''}`;
  for (const h of [r.reqHeaders, r.resHeaders]) {
    for (const [k, v] of Object.entries(h || {})) hay += ` ${k}: ${v}`;
  }
  // base64 (binary) bodies are excluded: matches inside base64 text are noise.
  if (r.reqBody != null && r.reqBodyEncoding !== 'base64') hay += ` ${r.reqBody}`;
  if (r.resBody != null && r.resBodyEncoding !== 'base64') hay += ` ${r.resBody}`;
  return hay.toLowerCase();
}

/** Host (with port) and path (with query) for keyed terms. */
function urlParts(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host.toLowerCase(), path: (u.pathname + u.search).toLowerCase() };
  } catch {
    // Unparseable url: match host: and path: against the whole string.
    const whole = url.toLowerCase();
    return { host: whole, path: whole };
  }
}

/**
 * `404`, `4xx` or `40x` (x is any digit), a prefix such as `5`, or the row
 * states `error` and `pending`.
 */
function statusMatches(r: CapturedRequest, value: string): boolean {
  if (value === 'error' || value === 'pending') return r.state === value;
  if (r.status == null || !/^[0-9x]{1,3}$/.test(value)) return false;
  const code = String(r.status);
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== 'x' && value[i] !== code[i]) return false;
  }
  return true;
}

export function matchesFilter(r: CapturedRequest, terms: readonly FilterTerm[]): boolean {
  // Built on first use: most filters never need the (body-sized) haystack.
  let hay: string | undefined;
  let parts: { host: string; path: string } | undefined;
  for (const t of terms) {
    let hit: boolean;
    switch (t.key) {
      case 'url':
        hit = r.url.toLowerCase().includes(t.value);
        break;
      case 'host':
        hit = (parts ??= urlParts(r.url)).host.includes(t.value);
        break;
      case 'path':
        hit = (parts ??= urlParts(r.url)).path.includes(t.value);
        break;
      case 'method':
        hit = r.method.toLowerCase() === t.value;
        break;
      case 'status':
        hit = statusMatches(r, t.value);
        break;
      case 'source':
        hit = (r.source || '') === t.value;
        break;
      default:
        hit = (hay ??= haystack(r)).includes(t.value);
    }
    if (hit === t.negate) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Seeding from the CLI: `netbridge --exclude <pattern>` pre-fills the box.
// ---------------------------------------------------------------------------

/**
 * The term that hides one --exclude pattern. Keyed patterns are negated as
 * given (`method:options` becomes `-method:options`); anything else is a url
 * substring (`localhost:4318` becomes `-url:localhost:4318`), so an exclusion
 * never reaches into bodies. Null when the pattern isn't a single term.
 */
export function exclusionTerm(pattern: string): string | null {
  const p = pattern.trim();
  if (!p || p.startsWith('-') || /\s/.test(p)) return null;
  const [term] = parseFilter(p);
  if (!term) return null;
  return term.key ? `-${p}` : `-url:${p}`;
}

/** Puts the exclusion terms `filter` doesn't already contain in front of it. */
export function withExclusions(filter: string, patterns: readonly string[]): string {
  const present = new Set(filter.toLowerCase().split(/\s+/));
  const added: string[] = [];
  for (const pattern of patterns) {
    const term = exclusionTerm(pattern);
    if (term === null || present.has(term.toLowerCase())) continue;
    present.add(term.toLowerCase());
    added.push(term);
  }
  if (added.length === 0) return filter;
  return filter.trim() ? `${added.join(' ')} ${filter}` : added.join(' ');
}

// ---------------------------------------------------------------------------
// Structured filters: chip toggles ANDed with the text query. Within one
// dimension selected values are ORed; an empty dimension matches everything.
// ---------------------------------------------------------------------------

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'error' | 'pending';

export interface StructuredFilter {
  methods: ReadonlySet<string>;
  statuses: ReadonlySet<StatusClass>;
  sources: ReadonlySet<string>;
  /** Inclusive duration bounds in ms; null leaves that side open. */
  minMs: number | null;
  maxMs: number | null;
}

/**
 * Parse a duration bound: "500", "500ms", "1s", "1.5 s" → ms. Bare numbers are
 * ms. Returns null for empty or unparseable input (i.e. no bound).
 */
export function parseDurationMs(input: string): number | null {
  const m = input
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 's' ? n * 1000 : n;
}

export function statusClassOf(r: CapturedRequest): StatusClass | null {
  if (r.state === 'error') return 'error';
  if (r.state === 'pending') return 'pending';
  if (r.status != null && r.status >= 200 && r.status < 600) {
    return `${Math.floor(r.status / 100)}xx` as StatusClass;
  }
  return null;
}

export function matchesStructured(r: CapturedRequest, f: StructuredFilter): boolean {
  if (f.methods.size > 0 && !f.methods.has(r.method.toUpperCase())) return false;
  if (f.statuses.size > 0) {
    const cls = statusClassOf(r);
    if (cls === null || !f.statuses.has(cls)) return false;
  }
  if (f.sources.size > 0 && !f.sources.has(r.source || '')) return false;
  if (f.minMs != null || f.maxMs != null) {
    // Pending rows have no duration yet, so they never satisfy a bound.
    const d = r.durationMs;
    if (d == null) return false;
    if (f.minMs != null && d < f.minMs) return false;
    if (f.maxMs != null && d > f.maxMs) return false;
  }
  return true;
}
