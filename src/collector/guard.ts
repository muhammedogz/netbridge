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

/** Host header names a loopback address (any port). */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = host ? hostnameOf(host) : null;
  return name !== null && LOOPBACK.has(name);
}

/** Origin is the collector's own: a loopback name on the collector's port. */
export function isOwnOrigin(origin: string, port: number): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname.toLowerCase()) && Number(u.port) === port;
  } catch {
    return false; // a malformed Origin is never ours
  }
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
  token: string
): { status: number; error: string } | null {
  if (!isLoopbackHost(req.headers.host)) return { status: 403, error: 'host not allowed' };
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH') {
    const origin = req.headers.origin;
    if (origin !== undefined && !isOwnOrigin(origin, port)) {
      return { status: 403, error: 'cross-origin request rejected' };
    }
    if (req.url === '/ingest' && !tokenMatches(req.headers['x-netbridge-token'], token)) {
      return { status: 401, error: 'missing or invalid ingest token' };
    }
  }
  return null;
}
