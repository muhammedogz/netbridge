import type { CapturedRequest } from './types';

export function fmtSize(body?: string, encoding?: string): string {
  if (!body) return '';
  const bytes = encoding === 'base64' ? Math.floor((body.length * 3) / 4) : new Blob([body]).size;
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
  return encoding === 'base64' ? Math.floor((body.length * 3) / 4) : new Blob([body]).size;
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
