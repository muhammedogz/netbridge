/**
 * Wraps http.request / https.request (and .get variants) to capture traffic
 * from clients built on Node's classic HTTP stack: axios, got, superagent...
 *
 * Body capture strategy:
 * - request body: wrap req.write / req.end and collect chunks
 * - response body: patch res.emit to tee 'data' chunks WITHOUT changing the
 *   stream's flowing/paused state (the same technique APM agents use)
 * - compressed responses are decompressed best-effort before transport, so
 *   the UI shows real JSON instead of gzip bytes (the thing Node's native
 *   network inspection gets wrong)
 */
import type * as httpType from 'http';
import {
  BodyCollector,
  decompressBody,
  emit,
  encodeBody,
  isOwnTraffic,
  nextId,
  sanitizeHeaders,
} from './shared';

type RequestFn = typeof httpType.request;

function buildUrl(protocol: string, args: unknown[]): { url: string; method: string } {
  let url = '';
  let method = 'GET';
  let options: Record<string, any> | undefined;

  const [first, second] = args;
  if (typeof first === 'string') {
    url = first;
    if (second && typeof second === 'object') options = second as Record<string, any>;
  } else if (first instanceof URL) {
    url = first.href;
    if (second && typeof second === 'object') options = second as Record<string, any>;
  } else if (first && typeof first === 'object') {
    options = first as Record<string, any>;
  }

  if (options) {
    method = (options.method || method).toUpperCase();
    if (!url) {
      const proto = options.protocol ? String(options.protocol).replace(':', '') : protocol;
      const host = options.hostname || options.host || 'localhost';
      const defaultPort = proto === 'https' ? 443 : 80;
      const port = options.port && Number(options.port) !== defaultPort ? `:${options.port}` : '';
      const path = options.path || '/';
      url = `${proto}://${host}${port}${path}`;
    }
  }
  if (url && !url.startsWith('http')) url = `${protocol}://${url}`;
  return { url, method };
}

function instrument(req: httpType.ClientRequest, url: string, method: string): void {
  const id = nextId();
  const start = Date.now();
  const reqBody = new BodyCollector();
  let startEmitted = false;

  const emitStart = () => {
    if (startEmitted) return;
    startEmitted = true;
    const encoded = reqBody.isEmpty ? undefined : encodeBody(reqBody.buffer());
    emit({
      id,
      phase: 'start',
      ts: start,
      pid: process.pid,
      source: 'http',
      method,
      url,
      reqHeaders: sanitizeHeaders(safeGetHeaders(req)),
      reqBody: encoded?.body,
      reqBodyEncoding: encoded?.encoding,
      reqBodyTruncated: reqBody.truncated || undefined,
    });
  };

  // Collect request body chunks.
  const origWrite = req.write.bind(req);
  const origEnd = req.end.bind(req);
  req.write = function (chunk: any, ...rest: any[]) {
    reqBody.push(chunk);
    return origWrite(chunk, ...rest);
  } as typeof req.write;
  req.end = function (chunk?: any, ...rest: any[]) {
    if (chunk !== undefined && typeof chunk !== 'function') reqBody.push(chunk);
    const result = origEnd(chunk, ...rest);
    emitStart();
    return result;
  } as typeof req.end;

  req.on('response', (res: httpType.IncomingMessage) => {
    emitStart();
    const resBody = new BodyCollector();

    // Tee data without disturbing stream state.
    const origEmit = res.emit.bind(res);
    res.emit = function (event: string | symbol, ...eventArgs: any[]) {
      if (event === 'data') resBody.push(eventArgs[0]);
      if (event === 'end') finalize();
      return origEmit(event as any, ...eventArgs);
    } as typeof res.emit;

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      let encoded: { body: string; encoding: 'utf8' | 'base64' } | undefined;
      let truncated = resBody.truncated;
      if (!resBody.isEmpty) {
        // Only decompress complete bodies — partial compressed data cannot be
        // decoded, so truncated compressed bodies stay base64.
        const raw = resBody.buffer();
        const contentEncoding = String(res.headers['content-encoding'] || '');
        const decoded = truncated && contentEncoding ? raw : decompressBody(raw, contentEncoding);
        encoded = encodeBody(decoded);
      }
      emit({
        id,
        phase: 'end',
        ts: Date.now(),
        pid: process.pid,
        source: 'http',
        method,
        url,
        status: res.statusCode,
        statusText: res.statusMessage,
        resHeaders: sanitizeHeaders(res.headers as Record<string, unknown>),
        resBody: encoded?.body,
        resBodyEncoding: encoded?.encoding,
        resBodyTruncated: truncated || undefined,
        durationMs: Date.now() - start,
      });
    };

    res.on('error', () => finalize());
  });

  req.on('error', (err: Error) => {
    emitStart();
    emit({
      id,
      phase: 'error',
      ts: Date.now(),
      pid: process.pid,
      source: 'http',
      method,
      url,
      durationMs: Date.now() - start,
      error: err.message,
    });
  });
}

function safeGetHeaders(req: httpType.ClientRequest): Record<string, unknown> {
  try {
    return req.getHeaders();
  } catch {
    return {};
  }
}

function wrapModule(mod: typeof httpType, protocol: 'http' | 'https'): void {
  const origRequest: RequestFn = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);

  mod.request = function (...args: any[]) {
    const req = (origRequest as any)(...args);
    try {
      const { url, method } = buildUrl(protocol, args);
      if (url && !isOwnTraffic(url)) instrument(req, url, method);
    } catch {
      /* never break the host app */
    }
    return req;
  } as RequestFn;

  // http.get does NOT call the patched exports.request (it closes over the
  // internal function), so wrap it separately.
  mod.get = function (...args: any[]) {
    const req = (origGet as any)(...args);
    try {
      const { url, method } = buildUrl(protocol, args);
      if (url && !isOwnTraffic(url)) instrument(req, url, method || 'GET');
    } catch {
      /* never break the host app */
    }
    return req;
  } as typeof mod.get;
}

export function patchHttp(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http') as typeof httpType;
  const https = require('https') as typeof httpType;
  wrapModule(http, 'http');
  wrapModule(https, 'https');
}
