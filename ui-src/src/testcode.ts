/**
 * A captured call as a test double: an MSW handler or a nock scope that
 * answers like the real backend did. Pasted into a test, it replays the
 * exact status, headers and body the app got.
 */
import { REDACTED } from '../../src/protocol';
import type { CapturedRequest } from './types';

// Headers that describe the captured wire bytes rather than the body the
// double will send (the libraries compute them), plus the per-response date.
const SKIP_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'date']);

function responseHeaders(r: CapturedRequest, dropContentType: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.resHeaders ?? {})) {
    const key = k.toLowerCase();
    if (SKIP_HEADERS.has(key) || v === REDACTED || (dropContentType && key === 'content-type')) continue;
    out[key] = v;
  }
  return out;
}

/** The parsed JSON body, or undefined when the body isn't JSON text. */
function jsonBody(body: string | undefined, encoding: string | undefined): unknown {
  if (body == null || encoding === 'base64') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * A JS literal for a value: on one line when it is short, otherwise spread
 * over lines indented to sit at `indent` inside the generated code.
 */
function literal(value: unknown, indent: string): string {
  const oneLine = JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
  if (oneLine.length <= 72) return oneLine;
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function splitUrl(url: string): { origin: string; path: string; query: [string, string][] } {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname, query: [...u.searchParams] };
  } catch {
    return { origin: url, path: '/', query: [] };
  }
}

function notes(r: CapturedRequest): string[] {
  const out: string[] = [];
  if (r.resBodyTruncated) out.push('// the captured body was truncated: this answers with its first part only');
  if (Object.values(r.resHeaders ?? {}).includes(REDACTED)) out.push('// redacted response headers are left out');
  return out;
}

const MSW_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** An MSW (v2) request handler answering like the captured response. */
export function formatMswHandler(r: CapturedRequest): string {
  const method = (r.method || 'GET').toLowerCase();
  const fn = MSW_METHODS.has(method) ? method : 'all';
  const { origin, path, query } = splitUrl(r.url);
  const lines = ["import { http, HttpResponse } from 'msw';", ''];
  // MSW matches the path alone; it ignores the query string.
  if (query.length) lines.push(`// captured with ?${new URLSearchParams(query)}: MSW matches the path only`);
  lines.push(...notes(r));

  let answer: string;
  if (r.state === 'error') {
    answer = 'HttpResponse.error()';
  } else {
    const status = r.status ?? 200;
    const json = jsonBody(r.resBody, r.resBodyEncoding);
    const headers = responseHeaders(r, json !== undefined);
    const init: string[] = [];
    if (status !== 200) init.push(`status: ${status}`);
    if (Object.keys(headers).length) init.push(`headers: ${literal(headers, '  ')}`);
    const initArg = init.length ? `, { ${init.join(', ')} }` : '';
    if (json !== undefined) {
      answer = `HttpResponse.json(${literal(json, '  ')}${initArg})`;
    } else if (r.resBody != null && r.resBodyEncoding === 'base64') {
      answer = `new HttpResponse(Uint8Array.from(atob(${JSON.stringify(r.resBody)}), (c) => c.charCodeAt(0))${initArg})`;
    } else {
      const body = r.resBody == null || r.resBody === '' ? 'null' : JSON.stringify(r.resBody);
      answer = `new HttpResponse(${body}${initArg})`;
    }
  }
  lines.push(`export const handler = http.${fn}(${JSON.stringify(origin + path)}, () =>`, `  ${answer}`, ');');
  return lines.join('\n');
}

/** A nock scope answering like the captured response, once. */
export function formatNock(r: CapturedRequest): string {
  const method = (r.method || 'GET').toLowerCase();
  const { origin, path, query } = splitUrl(r.url);
  const lines = ["import nock from 'nock';", ''];
  lines.push(...notes(r));

  // Match the request body when it was JSON, so a changed payload fails loudly.
  const reqJson = jsonBody(r.reqBody, r.reqBodyEncoding);
  const intercept =
    method === 'get' || method === 'head' || method === 'delete' || method === 'options'
      ? `.${method}(${JSON.stringify(path)})`
      : ['post', 'put', 'patch'].includes(method)
        ? `.${method}(${JSON.stringify(path)}${reqJson !== undefined ? `, ${literal(reqJson, '  ')}` : ''})`
        : `.intercept(${JSON.stringify(path)}, ${JSON.stringify(r.method)})`;

  const chain = [`nock(${JSON.stringify(origin)})`, `  ${intercept}`];
  if (query.length) {
    const q: Record<string, string | string[]> = {};
    for (const [k, v] of query) {
      const prev = q[k];
      q[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    chain.push(`  .query(${literal(q, '  ')})`);
  }

  if (r.state === 'error') {
    chain.push(`  .replyWithError(${JSON.stringify(r.error ?? 'network error')});`);
  } else {
    const json = jsonBody(r.resBody, r.resBodyEncoding);
    const headers = responseHeaders(r, false);
    const body =
      json !== undefined
        ? literal(json, '  ')
        : r.resBody != null && r.resBodyEncoding === 'base64'
          ? `Buffer.from(${JSON.stringify(r.resBody)}, 'base64')`
          : JSON.stringify(r.resBody ?? '');
    const headerArg = Object.keys(headers).length ? `, ${literal(headers, '  ')}` : '';
    chain.push(`  .reply(${r.status ?? 200}, ${body}${headerArg});`);
  }
  lines.push(chain.join('\n'));
  return lines.join('\n');
}
