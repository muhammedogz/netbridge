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

type BodyInfo = { body?: string; encoding?: 'utf8' | 'base64'; truncated?: boolean };

function limitedBody(buf: Buffer, truncated: boolean): BodyInfo {
  if (buf.length === 0 && !truncated) return {};
  const { body, encoding } = encodeBody(buf);
  return { body, encoding, truncated: truncated || undefined };
}

/** Read up to the body limit from a stream, then cancel the rest. */
async function readLimited(stream: ReadableStream<Uint8Array>): Promise<BodyInfo> {
  const collector = new BodyCollector();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(value);
      if (collector.truncated) {
        reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    /* keep whatever arrived */
  }
  return limitedBody(collector.buffer(), collector.truncated);
}

async function captureRequestBody(input: unknown, init: RequestInit | undefined): Promise<BodyInfo> {
  try {
    const source: unknown = init?.body;
    if (source === undefined && isRequest(input) && input.body) {
      // Read a clone (the original stays consumable), and only up to the
      // limit: arrayBuffer() would buffer an upload of any size in memory
      // before it was even sent.
      return await readLimited(input.clone().body as ReadableStream<Uint8Array>);
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
      return limitedBody(buf.subarray(0, config.bodyLimit), buf.length > config.bodyLimit);
    }
    // FormData / Blob / ReadableStream in init: skip (cannot read without
    // consuming the caller's stream or heavy buffering).
    return {};
  } catch {
    return {};
  }
}

/**
 * A fetch Request, including one from another copy of undici (the npm
 * package, a bundled one) that fails `instanceof Request`.
 */
function isRequest(input: unknown): input is Request {
  if (typeof Request !== 'undefined' && input instanceof Request) return true;
  const r = input as Partial<Request> | null;
  return (
    !!r && typeof r === 'object' && typeof r.url === 'string' && typeof r.method === 'string' && typeof r.clone === 'function'
  );
}

function captureResponseBody(response: Response, id: string, base: Record<string, unknown>, start: number): void {
  // durationMs runs until the body is done, as in the http wrapper: time to
  // headers alone made a slow download look fast.
  const done = () => ({ ...(base as any), id, phase: 'end' as const, ts: Date.now(), durationMs: Date.now() - start });
  const finishEmpty = () => emit(done());
  const finish = (collector: BodyCollector) => {
    if (collector.isEmpty) return finishEmpty();
    const { body, encoding } = encodeBody(collector.buffer());
    emit({
      ...done(),
      resBody: body,
      resBodyEncoding: encoding,
      resBodyTruncated: collector.truncated || undefined,
    });
  };

  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    finishEmpty();
    return;
  }

  // Stream the cloned body and stop once the cap is hit, cancelling the rest,
  // so a large download is never buffered whole into the host app's memory
  // (arrayBuffer() would read it all before we could truncate it).
  const stream = clone.body;
  if (stream && typeof stream.getReader === 'function') {
    const collector = new BodyCollector();
    const reader = stream.getReader();
    const pump = (): Promise<void> =>
      reader.read().then(({ done, value }) => {
        if (done) return finish(collector);
        collector.push(value);
        if (collector.truncated) {
          reader.cancel().catch(() => {});
          return finish(collector);
        }
        return pump();
      });
    // On a mid-stream error, emit whatever partial body we managed to collect.
    pump().catch(() => finish(collector));
    return;
  }

  // Fallback for environments without a web ReadableStream body.
  clone
    .arrayBuffer()
    .then((ab) => {
      const collector = new BodyCollector();
      collector.push(Buffer.from(ab));
      finish(collector);
    })
    .catch(finishEmpty);
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
      else if (isRequest(input)) {
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
      ...headersToObject(isRequest(input) ? input.headers : undefined),
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
      };
      captureResponseBody(response, id, base, start);
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
