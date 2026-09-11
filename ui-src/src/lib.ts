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

/** Inverse of headersText: one "Key: value" per line, split on the first colon. */
export function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

export interface ResendPayload {
  id?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
}

/** POST /api/resend; resolves with the settled replay entry. */
export async function resendRequest(payload: ResendPayload): Promise<CapturedRequest> {
  const res = await fetch('/api/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let message = `resend failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }
  return res.json();
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
// "Copy as code" — runnable client snippets rebuilt from a captured request.
// content-length is dropped everywhere: the client recomputes it, and a stale
// captured value goes wrong the moment the user edits the body.
// ---------------------------------------------------------------------------

function codeHeaders(r: CapturedRequest): [string, string][] {
  return Object.entries(r.reqHeaders || {}).filter(([k]) => k.toLowerCase() !== 'content-length');
}

export function formatRequestFetch(r: CapturedRequest): string {
  const method = (r.method || 'GET').toUpperCase();
  const headers = codeHeaders(r);
  const opts: string[] = [];
  if (method !== 'GET') opts.push(`  method: ${JSON.stringify(method)},`);
  if (headers.length) {
    opts.push('  headers: {');
    for (const [k, v] of headers) opts.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    opts.push('  },');
  }
  const notes: string[] = [];
  if (r.reqBody != null) {
    if (r.reqBodyEncoding === 'base64') {
      notes.push(`// binary body omitted (${fmtSize(r.reqBody, 'base64')}) — use download`);
    } else {
      opts.push(`  body: ${JSON.stringify(r.reqBody)},`);
    }
  }
  if (r.reqBodyTruncated) notes.push('// body truncated at capture');
  const optsBlock = opts.length ? `, {\n${opts.join('\n')}\n}` : '';
  const cmd = `await fetch(${JSON.stringify(r.url)}${optsBlock});`;
  return notes.length ? `${cmd}\n${notes.join('\n')}` : cmd;
}

// JSON string literals are valid Python string literals for everything
// JSON.stringify emits, so the same escaping is safe to reuse here.
export function formatRequestPython(r: CapturedRequest): string {
  const method = (r.method || 'GET').toUpperCase();
  const headers = codeHeaders(r);
  const lines: string[] = ['import requests', ''];
  const args: string[] = [JSON.stringify(method), JSON.stringify(r.url)];
  if (headers.length) {
    lines.push('headers = {');
    for (const [k, v] of headers) lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    lines.push('}');
    args.push('headers=headers');
  }
  const notes: string[] = [];
  if (r.reqBody != null) {
    if (r.reqBodyEncoding === 'base64') {
      notes.push(`# binary body omitted (${fmtSize(r.reqBody, 'base64')}) — use download`);
    } else {
      args.push(`data=${JSON.stringify(r.reqBody)}`);
    }
  }
  if (r.reqBodyTruncated) notes.push('# body truncated at capture');
  lines.push(`response = requests.request(${args.join(', ')})`);
  lines.push('print(response.status_code, response.text)');
  return lines.concat(notes).join('\n');
}

// ---------------------------------------------------------------------------
// "Copy as AI prompt" — a self-contained prompt that briefs an AI agent on one
// captured request: full wire data plus a task matched to how the call ended.
// ---------------------------------------------------------------------------

export function formatRequestPrompt(r: CapturedRequest): string {
  const intro =
    'Below is one outbound HTTP request captured server-side by netbridge (a network ' +
    'inspector for Node.js apps). It is the actual wire traffic my server sent and ' +
    'received — headers and bodies are real, not reconstructed.';

  let task: string;
  if (r.state === 'error') {
    task =
      `This request FAILED at the network level before receiving a response` +
      (r.error ? ` (error: \`${r.error}\`)` : '') +
      '. Diagnose the most likely root cause — consider DNS resolution, connection refused ' +
      '(wrong host/port, service not running), TLS problems, and timeouts — using the URL and ' +
      'request details above. Then give me the concrete fix, and a way to verify it.';
  } else if (r.status != null && r.status >= 500) {
    task =
      `This request came back with a server error (${r.status}${r.statusText ? ' ' + r.statusText : ''}). ` +
      'Read the response body/headers for the failure detail, but also check whether my request ' +
      '(URL, headers, body shape) could have triggered it. Tell me the most likely cause, whose side ' +
      'the bug is on, and what to change or check next.';
  } else if (r.status != null && r.status >= 400) {
    task =
      `This request was rejected (${r.status}${r.statusText ? ' ' + r.statusText : ''}), which usually ` +
      'means my request is wrong. Compare the request URL, query params, headers (auth, content-type) ' +
      'and body against what the response error says, identify exactly what the server objected to, ' +
      'and show me the corrected request.';
  } else {
    task =
      'This request succeeded. Explain what it does, and review it for anything worth improving or ' +
      'watching out for: payload shape, missing/odd headers, auth handling, response size, latency.';
  }

  const notes: string[] = [];
  if (r.reqBodyTruncated || r.resBodyTruncated) {
    notes.push('Note: bodies marked "(truncated)" were cut at the capture limit — the wire payload was larger.');
  }
  notes.push(
    'Note: sensitive header values (authorization, cookie, …) may be shown redacted; that is the inspector, not the wire.'
  );

  return [intro, '---', formatRequestMarkdown(r, true).trimEnd(), '---', `## Your task\n\n${task}`, notes.join('\n')].join(
    '\n\n'
  );
}

// ---------------------------------------------------------------------------
// Agent API instructions — copyable block that points an AI agent (or script)
// at the live collector API.
// ---------------------------------------------------------------------------

export function agentApiInstructions(origin: string): string {
  return `netbridge — a server-side HTTP inspector — is running at ${origin}, live-capturing this app's outbound HTTP traffic: method, url, status, headers, full request/response bodies, timing and errors.

Read the capture:
- GET  ${origin}/api/requests   every captured request, as a JSON array
- GET  ${origin}/api/health     collector info: { app: "netbridge", version, requests }
- GET  ${origin}/events         SSE stream (snapshot event, then live capture events)
- POST ${origin}/api/clear      reset the capture buffer
- POST ${origin}/api/resend     re-issue a captured request; JSON body {"id"} resends as-is, {"id", "method"?, "url"?, "headers"?, "body"?} resends with edits ("body": null sends no body); returns the settled replay entry (source "replay", replayOf links the original). Requires the header "content-type: application/json" (e.g. curl -H). Redacted header values are stripped before sending.

Example: \`curl -s ${origin}/api/requests\` shows exactly what the server sent and received. Use it to verify outbound calls, inspect payloads, and diagnose failures (entries with state "error", or status >= 400).

Reading entries: bodies over the capture limit carry reqBodyTruncated/resBodyTruncated: true; binary bodies are base64 (reqBodyEncoding/resBodyEncoding: "base64"); sensitive header values (authorization, cookie, …) are redacted by default.`;
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
