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
