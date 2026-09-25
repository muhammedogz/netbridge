/**
 * Request guards. Binding to 127.0.0.1 keeps other machines out, but not web
 * pages the developer has open, which can reach the collector through the
 * browser:
 *
 * - DNS rebinding: a page whose hostname re-resolves to 127.0.0.1 is
 *   same-origin with the collector and could read every captured body. The
 *   browser still sends the page's hostname in Host, so only loopback Host
 *   names are served.
 * - Drive-by POSTs: a `text/plain` POST is a CORS "simple request", sent
 *   without a preflight. Browsers attach Origin to every POST, so a present
 *   Origin must be the collector's own. Scripts and curl send none.
 * - /ingest additionally requires the per-run token the CLI hands the
 *   preloaded processes, so nothing else can inject entries.
 *
 * Remote dev setups that proxy the UI under another name (Codespaces,
 * Gitpod) list that name in NETBRIDGE_ALLOWED_HOSTS; it is then accepted as
 * a Host and as an Origin.
 */
import { timingSafeEqual } from 'crypto';
import type * as http from 'http';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Host header names a loopback address (any port) or an allowed host. */
export function isAllowedHost(host: string | undefined, allowed: ReadonlySet<string> = new Set()): boolean {
  const name = host ? hostnameOf(host) : null;
  return name !== null && (LOOPBACK.has(name) || allowed.has(name));
}

/**
 * Origin is the collector's own (a loopback name on the collector's port),
 * or an allowed host.
 */
export function isOwnOrigin(origin: string, port: number, allowed: ReadonlySet<string> = new Set()): boolean {
  try {
    const u = new URL(origin);
    const name = u.hostname.toLowerCase();
    if (allowed.has(name)) return true;
    return u.protocol === 'http:' && LOOPBACK.has(name) && Number(u.port) === port;
  } catch {
    return false; // a malformed Origin is never ours
  }
}

/** Parse a comma-separated host list (NETBRIDGE_ALLOWED_HOSTS). */
export function parseAllowedHosts(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const name = part.trim() ? hostnameOf(part.trim()) : null;
    if (name) out.add(name);
  }
  return out;
}

/** Constant-time token comparison. */
export function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Why a request must be refused, or null when it may proceed. */
export function refusal(
  req: http.IncomingMessage,
  port: number,
  token: string,
  allowed: ReadonlySet<string> = new Set()
): { status: number; error: string } | null {
  if (!isAllowedHost(req.headers.host, allowed)) {
    return { status: 403, error: 'host not allowed (see NETBRIDGE_ALLOWED_HOSTS)' };
  }
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH') {
    const origin = req.headers.origin;
    if (origin !== undefined && !isOwnOrigin(origin, port, allowed)) {
      return { status: 403, error: 'cross-origin request rejected' };
    }
    if (req.url === '/ingest' && !tokenMatches(req.headers['x-netbridge-token'], token)) {
      return { status: 401, error: 'missing or invalid ingest token' };
    }
  }
  return null;
}
