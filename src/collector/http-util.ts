/** Small request/response helpers shared by the collector's routes. */
import type * as http from 'http';

export function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function jsonError(res: http.ServerResponse, code: number, error: string): void {
  sendJson(res, code, { error });
}

/**
 * Buffer a request body, bounded by `cap` bytes. Collects raw Buffers (not
 * string concat) so multi-byte utf8 split across chunks is never corrupted and
 * the cap counts real bytes. On overflow it replies 413, cuts the socket and
 * resolves null; a client that vanishes mid-send also resolves null.
 */
export function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cap: number
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > cap) {
        res.writeHead(413).end();
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

/** readBody + JSON.parse; replies 400 on malformed JSON and resolves undefined. */
export async function readJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cap: number
): Promise<unknown> {
  const buf = await readBody(req, res, cap);
  if (!buf) return undefined;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    jsonError(res, 400, 'invalid JSON body');
    return undefined;
  }
}

/** Resolves once `res` can take more data (or has gone away). */
export function drained(res: http.ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Write a JSON array one item at a time, waiting for the socket to drain.
 * One JSON.stringify over the whole table can pass V8's maximum string
 * length (~512M chars) and throw; this never builds more than one item. An
 * item that cannot be serialized is skipped.
 */
export async function streamJsonArray(res: http.ServerResponse, items: readonly unknown[]): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/json' });
  let sep = '[';
  for (const item of items) {
    let json: string;
    try {
      json = JSON.stringify(item);
    } catch {
      continue;
    }
    if (!res.write(sep + json)) await drained(res);
    if (res.destroyed) return;
    sep = ',';
  }
  res.end(sep === '[' ? '[]' : ']');
}
