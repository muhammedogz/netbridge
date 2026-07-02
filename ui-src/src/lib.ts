import type { CapturedRequest } from './types';

/**
 * Exact UTF-8 byte length without allocating a Blob/TextEncoder per call.
 * fmtSize is mapped over every row on every render, so `new Blob([body]).size`
 * churned (and GC'd) a Blob per cell per frame; this is allocation-free and
 * returns the same byte count.
 */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function fmtSize(body?: string, encoding?: string): string {
  if (!body) return '';
  const bytes = encoding === 'base64' ? Math.floor((body.length * 3) / 4) : utf8ByteLength(body);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function displayBody(body?: string, encoding?: string): string | null {
  if (body == null) return null;
  if (encoding === 'base64') return body.length > 4096 ? `${body.slice(0, 4096)}…` : body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function headersText(obj?: Record<string, string>): string {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Filtering — every whitespace-separated term must match (case-insensitive
// substring) somewhere in metadata, headers, or utf8 bodies.
// ---------------------------------------------------------------------------

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

export function matchesFilter(r: CapturedRequest, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystack(r);
  return terms.every((t) => hay.includes(t));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function bodyFilename(
  r: CapturedRequest,
  kind: 'request' | 'response',
  encoding?: string,
  headers?: Record<string, string>
): string {
  const ct = String(headers?.['content-type'] || '');
  const ext =
    encoding === 'base64'
      ? 'bin'
      : ct.includes('json')
        ? 'json'
        : ct.includes('html')
          ? 'html'
          : ct.includes('xml')
            ? 'xml'
            : 'txt';
  let host = 'request';
  try {
    host = new URL(r.url).host.replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    /* keep default */
  }
  return `netbridge-${kind}-${host}-${r.id}.${ext}`;
}

// ---------------------------------------------------------------------------
// "Copy whole request" formatters — Markdown (beautiful, shareable) and JSON.
// Two scopes: essentials (url + bodies) and everything (+ headers + metadata).
// ---------------------------------------------------------------------------

function bodyBytes(body?: string, encoding?: string): number {
  if (!body) return 0;
  return encoding === 'base64' ? Math.floor((body.length * 3) / 4) : utf8ByteLength(body);
}

/** Pretty body text + a markdown fence language hint. */
function bodyForMarkdown(
  body?: string,
  encoding?: string,
  headers?: Record<string, string>
): { text: string; lang: string } | { note: string } {
  if (body == null) return { note: '_(no body captured)_' };
  if (encoding === 'base64') {
    return { note: `_binary body (base64, ${fmtSize(body, encoding)}) — use download to save_` };
  }
  const pretty = displayBody(body, encoding) ?? body;
  const ct = String(headers?.['content-type'] || '');
  let lang = '';
  try {
    JSON.parse(body);
    lang = 'json';
  } catch {
    lang = ct.includes('html') ? 'html' : ct.includes('xml') ? 'xml' : '';
  }
  return { text: pretty, lang };
}

/** Fence that won't collide with backticks inside the body. */
function fenceFor(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return fence;
}

function mdBodySection(
  title: string,
  body?: string,
  encoding?: string,
  truncated?: boolean,
  headers?: Record<string, string>
): string {
  const formatted = bodyForMarkdown(body, encoding, headers);
  if ('note' in formatted) return `### ${title}\n${formatted.note}\n`;
  const fence = fenceFor(formatted.text);
  const trunc = truncated ? ' _(truncated)_' : '';
  return `### ${title}${trunc}\n${fence}${formatted.lang}\n${formatted.text}\n${fence}\n`;
}

function mdHeaders(title: string, headers?: Record<string, string>): string {
  const text = headersText(headers);
  if (!text) return `### ${title}\n_(none)_\n`;
  return `### ${title}\n\`\`\`\n${text}\n\`\`\`\n`;
}

export function formatRequestMarkdown(r: CapturedRequest, full: boolean): string {
  const statusLine =
    r.state === 'error'
      ? `**ERROR** — ${r.error || 'request failed'}`
      : r.state !== 'done'
        ? '_(pending)_'
        : `**${r.status ?? '?'}${r.statusText ? ' ' + r.statusText : ''}**`;
  const meta = [
    r.durationMs != null ? `${r.durationMs} ms` : null,
    r.source || null,
  ].filter(Boolean);

  const parts: string[] = [];
  parts.push(`${r.method} ${r.url}`);
  parts.push(`${statusLine}${meta.length ? ' · ' + meta.join(' · ') : ''}\n`);

  if (full) parts.push(mdHeaders('Request headers', r.reqHeaders));
  parts.push(mdBodySection('Request body', r.reqBody, r.reqBodyEncoding, r.reqBodyTruncated, r.reqHeaders));
  if (full) parts.push(mdHeaders('Response headers', r.resHeaders));
  parts.push(mdBodySection('Response body', r.resBody, r.resBodyEncoding, r.resBodyTruncated, r.resHeaders));

  if (full) {
    const metaLines = [
      r.pid != null ? `- pid: ${r.pid}` : null,
      r.seq != null ? `- seq: ${r.seq}` : null,
      r.ts != null ? `- time: ${new Date(r.ts).toISOString()}` : null,
      r.reqBodyEncoding ? `- request body encoding: ${r.reqBodyEncoding}` : null,
      r.resBodyEncoding ? `- response body encoding: ${r.resBodyEncoding}` : null,
    ].filter(Boolean);
    if (metaLines.length) parts.push(`### Meta\n${metaLines.join('\n')}\n`);
  }

  return parts.join('\n').trimEnd() + '\n';
}

/** Parse a captured body into a JSON-friendly value (object when JSON). */
function bodyForJson(body?: string, encoding?: string): unknown {
  if (body == null) return undefined;
  if (encoding === 'base64') return { binary: true, base64: body, bytes: bodyBytes(body, encoding) };
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function formatRequestJSON(r: CapturedRequest, full: boolean): string {
  const out: Record<string, unknown> = {
    method: r.method,
    url: r.url,
    status: r.status,
    durationMs: r.durationMs,
    request: { body: bodyForJson(r.reqBody, r.reqBodyEncoding) },
    response: { body: bodyForJson(r.resBody, r.resBodyEncoding) },
  };
  if (r.state === 'error' && r.error) out.error = r.error;

  if (full) {
    out.statusText = r.statusText;
    out.source = r.source;
    out.pid = r.pid;
    out.seq = r.seq;
    out.ts = r.ts;
    out.request = {
      headers: r.reqHeaders,
      body: bodyForJson(r.reqBody, r.reqBodyEncoding),
      bodyEncoding: r.reqBodyEncoding,
      bodyTruncated: r.reqBodyTruncated,
    };
    out.response = {
      headers: r.resHeaders,
      body: bodyForJson(r.resBody, r.resBodyEncoding),
      bodyEncoding: r.resBodyEncoding,
      bodyTruncated: r.resBodyTruncated,
    };
  }
  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// "Copy as cURL" — a runnable POSIX-shell command from a captured request.
// ---------------------------------------------------------------------------

/** Single-quote for POSIX shells; embedded quotes use the '\'' idiom. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function formatRequestCurl(r: CapturedRequest): string {
  const parts: string[] = [`curl ${shellQuote(r.url)}`];
  const method = (r.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push(`-X ${method}`);

  for (const [name, value] of Object.entries(r.reqHeaders || {})) {
    // curl computes content-length itself; a stale captured value would be
    // wrong the moment the user edits the body.
    if (name.toLowerCase() === 'content-length') continue;
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }

  const comments: string[] = [];
  if (r.reqBody != null) {
    if (r.reqBodyEncoding === 'base64') {
      // Raw bytes cannot be inlined portably — flag instead of mangling.
      comments.push(`# binary body omitted (${fmtSize(r.reqBody, 'base64')}) — use download`);
    } else {
      parts.push(`--data-raw ${shellQuote(r.reqBody)}`);
    }
  }
  if (r.reqBodyTruncated) comments.push('# body truncated at capture');

  const cmd = parts.join(' \\\n  ');
  return comments.length ? `${cmd}\n${comments.join('\n')}` : cmd;
}

// ---------------------------------------------------------------------------
// HAR 1.2 export — hand-written mapping (spec is small; keeps zero deps).
// Custom fields are underscore-prefixed as the HAR spec requires.
// ---------------------------------------------------------------------------

function harHeaders(h?: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(h || {}).map(([name, value]) => ({ name, value }));
}

function harQueryString(url: string): { name: string; value: string }[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function buildHar(requests: CapturedRequest[], version: string): object {
  // seq exists only on client-side rows; server dumps arrive in insertion
  // order and the sort is stable, so both sources come out chronological.
  const entries = [...requests]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((r) => {
      const time = r.durationMs ?? 0;
      const reqCt = String(r.reqHeaders?.['content-type'] || '');
      const resCt = String(r.resHeaders?.['content-type'] || '');
      const entry: Record<string, unknown> = {
        // Merged rows carry the ts of the LAST phase (the end event), so the
        // real start is ts minus duration; pending rows only have the start ts.
        startedDateTime: new Date(r.ts - (r.durationMs ?? 0)).toISOString(),
        time,
        request: {
          method: r.method,
          url: r.url,
          httpVersion: 'HTTP/1.1',
          headers: harHeaders(r.reqHeaders),
          queryString: harQueryString(r.url),
          cookies: [],
          headersSize: -1,
          bodySize: bodyBytes(r.reqBody, r.reqBodyEncoding),
          ...(r.reqBody != null
            ? {
                postData: {
                  mimeType: reqCt || 'application/octet-stream',
                  text: r.reqBody,
                  // Official `encoding` exists only on response content; use a
                  // HAR-legal custom field for binary request bodies.
                  ...(r.reqBodyEncoding === 'base64' ? { _encoding: 'base64' } : {}),
                },
              }
            : {}),
        },
        response: {
          status: r.status ?? 0,
          statusText: r.statusText ?? '',
          httpVersion: 'HTTP/1.1',
          headers: harHeaders(r.resHeaders),
          cookies: [],
          content: {
            size: bodyBytes(r.resBody, r.resBodyEncoding),
            mimeType: resCt || 'x-unknown',
            ...(r.resBody != null ? { text: r.resBody } : {}),
            ...(r.resBodyEncoding === 'base64' ? { encoding: 'base64' } : {}),
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: bodyBytes(r.resBody, r.resBodyEncoding),
        },
        cache: {},
        // Only the total is known; the spec requires the parts to sum to time.
        timings: { send: 0, wait: time, receive: 0 },
      };
      if (r.state === 'error' && r.error) entry._error = r.error;
      if (r.state === 'pending') entry._state = 'pending';
      if (r.reqBodyTruncated || r.resBodyTruncated) entry._bodyTruncated = true;
      return entry;
    });

  return {
    log: {
      version: '1.2',
      creator: { name: 'netbridge', version },
      entries,
    },
  };
}

export function downloadBody(r: CapturedRequest, kind: 'request' | 'response'): void {
  const body = kind === 'response' ? r.resBody : r.reqBody;
  const encoding = kind === 'response' ? r.resBodyEncoding : r.reqBodyEncoding;
  const headers = kind === 'response' ? r.resHeaders : r.reqHeaders;
  if (body == null) return;
  let blob: Blob;
  if (encoding === 'base64') {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: 'application/octet-stream' });
  } else {
    blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  }
  downloadBlob(blob, bodyFilename(r, kind, encoding, headers));
}
