import { claimTime, type DecodedToken, decodeJwt, startedAt } from '../../../src/protocol';
import type { CapturedRequest } from '../types';

/** A token and where it was found: a header, or a field of the response body. */
export interface FoundToken {
  where: string;
  jose: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export function fromHeaders(tokens: DecodedToken[] | undefined): FoundToken[] {
  return (tokens ?? []).map((t) => ({ where: t.scheme ? `${t.header}: ${t.scheme}` : t.header, jose: t.jose, claims: t.claims }));
}

const MAX_BODY_TOKENS = 5;

/** JWTs in a JSON body (`access_token`, `id_token`, …), or anywhere in a text one. */
export function tokensInBody(body: string | undefined, encoding: string | undefined): FoundToken[] {
  if (!body || encoding === 'base64' || !body.includes('eyJ')) return [];
  const out: FoundToken[] = [];
  const add = (where: string, value: string) => {
    if (out.length >= MAX_BODY_TOKENS) return;
    const d = decodeJwt(value);
    if (d) out.push({ where, ...d });
  };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    for (const m of body.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g)) add('body', m[0]);
    return out;
  }
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') add(path || 'body', v);
    else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`);
    }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(json, '');
  return out;
}

function ago(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export interface TokenTiming {
  /** Expired, or not valid yet, at the time of the call. */
  bad: boolean;
  text: string;
}

/** The token's validity at `at` (the time of the call). */
export function tokenTiming(claims: Record<string, unknown>, at: number): TokenTiming | null {
  const exp = claimTime(claims, 'exp');
  const nbf = claimTime(claims, 'nbf');
  if (nbf != null && at < nbf) return { bad: true, text: `not valid yet: starts ${ago(nbf - at)} after this call` };
  if (exp == null) return null;
  return at >= exp
    ? { bad: true, text: `expired ${ago(at - exp)} before this call` }
    : { bad: false, text: `valid for ${ago(exp - at)} more at the time of this call` };
}

/** True when a request token was expired (or not valid yet) when the call went out. */
export function hasStaleToken(r: CapturedRequest): boolean {
  const at = startedAt(r);
  return (r.reqTokens ?? []).some((t) => tokenTiming(t.claims, at)?.bad);
}

// Claims worth a row of their own; the rest are in the full JSON.
const KEY_CLAIMS = ['iss', 'sub', 'aud', 'azp', 'client_id', 'scope', 'scp', 'typ', 'htm', 'htu', 'jti'];

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function TokenCard({ t, at }: { t: FoundToken; at: number }) {
  const timing = tokenTiming(t.claims, at);
  const times = (['iat', 'nbf', 'exp'] as const)
    .map((k) => [k, claimTime(t.claims, k)] as const)
    .filter(([, v]) => v != null);
  return (
    <div className="token">
      <div className="token-head">
        <span className="token-where">{t.where}</span>
        <span className="token-jose">
          {[t.jose.alg, t.jose.typ, t.jose.kid ? `kid ${t.jose.kid}` : ''].filter(Boolean).join(' · ')}
        </span>
        {timing && <span className={`badge${timing.bad ? ' bad' : ''}`}>{timing.text}</span>}
      </div>
      <div className="kv">
        {KEY_CLAIMS.filter((k) => t.claims[k] !== undefined).map((k) => (
          <span key={k} style={{ display: 'contents' }}>
            <span className="k">{k}</span>
            <span className="v">{show(t.claims[k])}</span>
          </span>
        ))}
        {times.map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            <span className="k">{k}</span>
            <span className="v">{new Date(v as number).toISOString()}</span>
          </span>
        ))}
      </div>
      <details>
        <summary>all claims</summary>
        <pre>{JSON.stringify(t.claims, null, 2)}</pre>
      </details>
    </div>
  );
}

/** Decoded JWTs, with their validity at the time of the call. */
export function TokensSection({ tokens, at, title }: { tokens: FoundToken[]; at: number; title: string }) {
  if (tokens.length === 0) return null;
  return (
    <div className="section">
      <div className="sec-head">
        <h3>{title}</h3>
        <span className="token-note">decoded, not verified</span>
      </div>
      {tokens.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one entry never reorder
        <TokenCard key={i} t={t} at={at} />
      ))}
    </div>
  );
}
