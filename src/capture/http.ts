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
import type { MockRule } from '../protocol';
import { currentParent } from './context';
import { mockFor } from './mocks';
import {
  BodyCollector,
  config,
  decompressBody,
  emit,
  encodeBody,
  isOwnTraffic,
  nextId,
  pristineHttpRequest,
  sanitizeHeaders,
} from './shared';

type RequestFn = typeof httpType.request;

/** Best-effort url and method of an http(s).request / .get call. */
export function buildUrl(protocol: string, args: unknown[]): { url: string; method: string } {
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
    method = String(options.method || method).toUpperCase();
    if (!url) {
      const proto = options.protocol ? String(options.protocol).replace(':', '') : protocol;
      const reqPath = options.path || '/';
      if (options.socketPath) {
        // Unix socket (Docker API and friends): the "http://unix:<socket>:<path>"
        // convention, instead of pretending the call went to localhost.
        return { url: `${proto}://unix:${options.socketPath}:${reqPath}`, method };
      }
      let host = String(options.hostname || options.host || 'localhost');
      if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`; // IPv6 literal
      const defaultPort = proto === 'https' ? 443 : 80;
      const port = options.port && Number(options.port) !== defaultPort ? `:${options.port}` : '';
      url = `${proto}://${host}${port}${reqPath}`;
    }
  }
  if (url && !url.startsWith('http')) url = `${protocol}://${url}`;
  return { url, method };
}

function instrument(req: httpType.ClientRequest, url: string, method: string, rule?: MockRule): void {
  const id = nextId();
  const start = Date.now();
  const parentId = currentParent();
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
      parentId,
      mocked: rule?.id,
      reqHeaders: sanitizeHeaders(safeGetHeaders(req)),
      reqBody: encoded?.body,
      reqBodyEncoding: encoded?.encoding,
      reqBodyTruncated: reqBody.truncated || undefined,
    });
  };

  // Collect request body chunks.
  const origWrite = req.write.bind(req);
  const origEnd = req.end.bind(req);
  // write(chunk[, encoding][, callback]) / end([chunk[, encoding]][, callback]):
  // the encoding is only meaningful for string chunks, and is the first rest arg
  // when it is a string (a function there is the callback).
  req.write = function (chunk: any, ...rest: any[]) {
    reqBody.push(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    return origWrite(chunk, ...rest);
  } as typeof req.write;
  req.end = function (chunk?: any, ...rest: any[]) {
    if (chunk !== undefined && typeof chunk !== 'function') {
      reqBody.push(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    }
    const result = origEnd(chunk, ...rest);
    emitStart();
    return result;
  } as typeof req.end;

  // Intercept the 'response' event at emit time — BEFORE any consumer
  // listener runs. Consumers like axios delete `content-encoding` from
  // res.headers synchronously in their response handler (they decompress
  // themselves); a plain req.on('response') would observe mutated headers.
  // A delay-only rule holds the real response back; its body waits in the
  // stream. If the caller gives up meanwhile (a timeout destroys the
  // request), the held response must never reach it. Natural closes don't
  // count: without keep-alive the socket closes as soon as the response is
  // in, long before the delay is up, which also sets req.destroyed.
  const holdResponse = !!rule?.delayMs && !rule.response && !rule.fail;
  let cancelled = false;
  if (holdResponse) {
    const origDestroy = req.destroy;
    req.destroy = function (this: httpType.ClientRequest, ...a: any[]) {
      cancelled = true;
      return (origDestroy as any).apply(this, a);
    } as typeof req.destroy;
    req.once('error', () => {
      cancelled = true;
    });
  }

  const origReqEmit = req.emit.bind(req);
  req.emit = function (event: string | symbol, ...emitArgs: any[]) {
    if (event === 'response') {
      onResponse(emitArgs[0] as httpType.IncomingMessage);
      // Mocked responses are delayed by the collector instead.
      if (holdResponse) {
        setTimeout(() => {
          if (!cancelled && !(req as { aborted?: boolean }).aborted) origReqEmit(event as any, ...emitArgs);
        }, rule?.delayMs);
        return true;
      }
    }
    return origReqEmit(event as any, ...emitArgs);
  } as typeof req.emit;

  const onResponse = (res: httpType.IncomingMessage) => {
    emitStart();
    const resBody = new BodyCollector();
    const headersSnapshot = { ...res.headers } as Record<string, unknown>;

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
      const truncated = resBody.truncated;
      if (!resBody.isEmpty) {
        // Only decompress complete bodies — partial compressed data cannot be
        // decoded, so truncated compressed bodies stay base64.
        const raw = resBody.buffer();
        const contentEncoding = String(headersSnapshot['content-encoding'] || '');
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
        resHeaders: sanitizeHeaders(headersSnapshot),
        resBody: encoded?.body,
        resBodyEncoding: encoded?.encoding,
        resBodyTruncated: truncated || undefined,
        durationMs: Date.now() - start,
      });
    };

    res.on('error', () => finalize());
    // A response the consumer never reads (no 'data'/'end') — or one that is
    // aborted mid-stream — would otherwise never finalize, leaving the request
    // stuck 'pending' forever. 'close' always fires; finalize is idempotent.
    res.on('aborted', () => finalize());
    res.on('close', () => finalize());
  };

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
    const headers = req.getHeaders();
    delete headers['x-netbridge-token'];
    return headers;
  } catch {
    return {};
  }
}

/**
 * Send a call a rule answers (or fails) to the collector's /__mock endpoint
 * instead. For a fail rule the collector holds the call until failRequest
 * destroys it. The
 * caller's headers and callback are kept; transport options (agent, TLS,
 * socket) belong to the real target and are dropped.
 */
function mockedRequest(args: unknown[], method: string, rule: MockRule): httpType.ClientRequest {
  const cb = args.find((a) => typeof a === 'function') as ((res: httpType.IncomingMessage) => void) | undefined;
  const options = args.find((a) => a && typeof a === 'object' && !(a instanceof URL)) as Record<string, any> | undefined;
  const headers: Record<string, unknown> = {};
  const given = options?.headers;
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    // Host names the real target; Origin and Referer would read as a web page
    // to the collector's guard and get the call refused.
    for (const [k, v] of Object.entries(given)) {
      if (!['host', 'origin', 'referer'].includes(k.toLowerCase())) headers[k] = v;
    }
  }
  headers['x-netbridge-token'] = config.token;
  return pristineHttpRequest(
    {
      host: '127.0.0.1',
      port: config.port,
      method,
      path: `/__mock/${encodeURIComponent(rule.id)}`,
      headers: headers as httpType.OutgoingHttpHeaders,
      timeout: options?.timeout,
      signal: options?.signal,
      agent: false,
    },
    cb
  );
}

/** A `fail` rule: the request errors out like a refused connection. */
function failRequest(req: httpType.ClientRequest, rule: MockRule): void {
  const err = Object.assign(new Error(`connect ECONNREFUSED (${rule.fail})`), { code: 'ECONNREFUSED' });
  const fail = () => req.destroy(err);
  if (rule.delayMs) {
    const t = setTimeout(fail, rule.delayMs);
    req.once('close', () => clearTimeout(t));
  } else {
    process.nextTick(fail);
  }
}

/** Create the request for a call, mocked when a rule says so, and instrument it. */
function request(original: (...args: any[]) => httpType.ClientRequest, protocol: string, args: any[], get: boolean) {
  let target: { url: string; method: string } | undefined;
  let rule: MockRule | undefined;
  try {
    target = buildUrl(protocol, args);
    if (get) target.method = 'GET';
    if (!target.url || isOwnTraffic(target.url)) target = undefined;
    else rule = mockFor(target.method, target.url);
  } catch {
    target = undefined;
  }
  let req: httpType.ClientRequest;
  // A rule that answers or fails never reaches the real backend: a failing
  // POST must not have its side effects.
  if (target && (rule?.response || rule?.fail)) {
    req = mockedRequest(args, target.method, rule);
    if (get) req.end();
  } else {
    req = original(...args);
  }
  try {
    if (target) instrument(req, target.url, target.method, rule);
    if (target && rule?.fail) failRequest(req, rule);
  } catch {
    /* never break the host app */
  }
  return req;
}

function wrapModule(mod: typeof httpType, protocol: 'http' | 'https'): void {
  const origRequest: RequestFn = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);

  mod.request = function (...args: any[]) {
    return request(origRequest as any, protocol, args, false);
  } as RequestFn;

  // http.get does NOT call the patched exports.request (it closes over the
  // internal function), so wrap it separately.
  mod.get = function (...args: any[]) {
    return request(origGet as any, protocol, args, true);
  } as typeof mod.get;
}

export function patchHttp(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http') as typeof httpType;
  const https = require('https') as typeof httpType;
  wrapModule(http, 'http');
  wrapModule(https, 'https');
}
