/**
 * Wraps globalThis.fetch to capture request/response metadata AND bodies.
 *
 * Why wrap fetch instead of undici diagnostics_channel? The dc channels expose
 * headers but not response bodies. Cloning the Response gives full bodies with
 * automatic decompression, for every fetch-based client (native fetch, ky, ...).
 *
 * Load order matters and works in our favor: the preload runs before the app
 * (and before Next.js patches fetch for caching), so Next wraps OUR wrapper —
 * every real outbound call still flows through us.
 */
import {
  BodyCollector,
  config,
  emit,
  encodeBody,
  isOwnTraffic,
  nextId,
  sanitizeHeaders,
} from './shared';

function headersToObject(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (headers && typeof (headers as Headers).forEach === 'function') {
      (headers as Headers).forEach((value, key) => {
        out[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [k, v] of headers) out[String(k)] = String(v);
    } else if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        out[k] = String(v);
      }
    }
  } catch {
    /* best effort */
  }
  return out;
}

async function captureRequestBody(
  input: unknown,
  init: RequestInit | undefined
): Promise<{ body?: string; encoding?: 'utf8' | 'base64'; truncated?: boolean }> {
  try {
    let source: unknown = init?.body;
    if (source === undefined && input instanceof Request && input.body) {
      // Clone so the original stream stays consumable.
      const buf = Buffer.from(await input.clone().arrayBuffer());
      if (buf.length === 0) return {};
      const limited = buf.subarray(0, config.bodyLimit);
      const { body, encoding } = encodeBody(limited);
      return { body, encoding, truncated: buf.length > config.bodyLimit };
    }
    if (source === undefined || source === null) return {};
    if (typeof source === 'string') {
      const truncated = source.length > config.bodyLimit;
      return { body: source.slice(0, config.bodyLimit), encoding: 'utf8', truncated };
    }
    if (source instanceof URLSearchParams) {
      return { body: source.toString().slice(0, config.bodyLimit), encoding: 'utf8' };
    }
    if (Buffer.isBuffer(source) || source instanceof Uint8Array || source instanceof ArrayBuffer) {
      const buf = Buffer.isBuffer(source)
        ? source
        : Buffer.from(source instanceof ArrayBuffer ? new Uint8Array(source) : source);
      const limited = buf.subarray(0, config.bodyLimit);
      const { body, encoding } = encodeBody(limited);
      return { body, encoding, truncated: buf.length > config.bodyLimit };
    }
    // FormData / Blob / ReadableStream: skip body capture in v1 (cannot read
    // without consuming or heavy buffering).
    return {};
  } catch {
    return {};
  }
}

function captureResponseBody(response: Response, id: string, base: Record<string, unknown>): void {
  try {
    const clone = response.clone();
    clone
      .arrayBuffer()
      .then((ab) => {
        const buf = Buffer.from(ab);
        const collector = new BodyCollector();
        collector.push(buf);
        const { body, encoding } = encodeBody(collector.buffer());
        emit({
          ...(base as any),
          id,
          phase: 'end',
          ts: Date.now(),
          resBody: collector.isEmpty ? undefined : body,
          resBodyEncoding: collector.isEmpty ? undefined : encoding,
          resBodyTruncated: collector.truncated || buf.length > config.bodyLimit,
        });
      })
      .catch(() => {
        emit({ ...(base as any), id, phase: 'end', ts: Date.now() });
      });
  } catch {
    emit({ ...(base as any), id, phase: 'end', ts: Date.now() });
  }
}

export function patchFetch(): void {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;

  const wrapped = async function netbridgeFetch(
    input: any,
    init?: RequestInit
  ): Promise<Response> {
    let url = '';
    let method = 'GET';
    try {
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input instanceof Request) {
        url = input.url;
        method = input.method || 'GET';
      } else url = String(input);
      if (init?.method) method = init.method;
      method = method.toUpperCase();
    } catch {
      /* keep defaults */
    }

    if (!url.startsWith('http') || isOwnTraffic(url)) {
      return original.call(globalThis, input, init);
    }

    const id = nextId();
    const start = Date.now();
    const reqHeaders = sanitizeHeaders({
      ...headersToObject(input instanceof Request ? input.headers : undefined),
      ...headersToObject(init?.headers),
    });

    const reqBodyInfo = await captureRequestBody(input, init);

    emit({
      id,
      phase: 'start',
      ts: start,
      pid: process.pid,
      source: 'fetch',
      method,
      url,
      reqHeaders,
      reqBody: reqBodyInfo.body,
      reqBodyEncoding: reqBodyInfo.encoding,
      reqBodyTruncated: reqBodyInfo.truncated,
    });

    try {
      const response = await original.call(globalThis, input, init);
      const base = {
        pid: process.pid,
        source: 'fetch' as const,
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        resHeaders: sanitizeHeaders(headersToObject(response.headers)),
        durationMs: Date.now() - start,
      };
      captureResponseBody(response, id, base);
      return response;
    } catch (err) {
      emit({
        id,
        phase: 'error',
        ts: Date.now(),
        pid: process.pid,
        source: 'fetch',
        method,
        url,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  Object.defineProperty(wrapped, 'name', { value: 'fetch' });
  globalThis.fetch = wrapped as typeof fetch;
}
