/**
 * netbridge smoke test — runs the real CLI against a fixture target and
 * asserts on the collector's /api/requests output.
 *
 * Covers: fetch GET/POST, http.get (gzip decompression), http.request POST,
 * header redaction, request/response body capture, error capture, both sources.
 */
import { spawn } from 'child_process';
import http from 'http';
import zlib from 'zlib';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'dist', 'cli.js');
const TARGET = path.join(__dirname, 'fixtures', 'target.mjs');
const NB_PORT = 4521;

// Fail fast with a clear message when the package wasn't built — the CLI and the
// web UI are required dist/ + ui/ artifacts; without them a bare `pnpm test`
// otherwise fails confusingly (spawn ENOENT, zero captures, opaque timeout).
if (!fs.existsSync(CLI) || !fs.existsSync(path.join(__dirname, '..', 'ui', 'index.html'))) {
  console.error('netbridge smoke test: missing build artifacts — run `pnpm build` first.');
  process.exit(1);
}

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

// --- local origin server -----------------------------------------------
const origin = http.createServer((req, res) => {
  if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ route: 'json', ok: true }));
  } else if (req.url === '/gzip') {
    const payload = zlib.gzipSync(JSON.stringify({ route: 'gzip', compressed: true }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(payload);
  } else if (req.url === '/echo') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: body }));
    });
  } else if (req.url === '/boom') {
    // Drop the connection with no response → the client sees a network error.
    req.socket.destroy();
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originPort = origin.address().port;

// --- run CLI with fixture target ----------------------------------------
const child = spawn(process.execPath, [CLI, '--port', String(NB_PORT), '--', process.execPath, TARGET], {
  env: { ...process.env, TARGET_ORIGIN_PORT: String(originPort), NETBRIDGE_QUIET: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let cliOutput = '';
child.stdout.on('data', (c) => (cliOutput += c));
child.stderr.on('data', (c) => (cliOutput += c));

// --- guaranteed cleanup on EVERY exit path (normal end, early process.exit,
// --- uncaught error) so no child CLI/app or origin/blocker server is leaked. -
let childB = null;
let blocker = null;
function cleanup() {
  for (const c of [child, childB]) {
    try {
      if (c && c.exitCode === null && c.signalCode === null) c.kill();
    } catch {
      /* ignore */
    }
  }
  for (const s of [origin, blocker]) {
    try {
      if (s) s.close();
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup);

// The collector auto-increments past a busy port, so read the ACTUAL port from
// the CLI banner rather than trusting NB_PORT — a busy 4521 must not make us
// poll the wrong port and fail spuriously.
let portA = NB_PORT;
for (let i = 0; i < 50; i++) {
  const m = cliOutput.match(/http:\/\/localhost:(\d+)/);
  if (m) {
    portA = Number(m[1]);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

// --- poll collector until all 5 requests reach a terminal state ----------
async function fetchRequests() {
  try {
    const res = await fetch(`http://127.0.0.1:${portA}/api/requests`);
    return await res.json();
  } catch {
    return null;
  }
}

let captured = null;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const list = await fetchRequests();
  if (
    list &&
    list.length >= 5 &&
    list.every((r) => r.state === 'done' || r.state === 'error')
  ) {
    captured = list;
    break;
  }
}

if (!captured) {
  console.error('FAIL  did not capture 5 settled requests in time');
  console.error('--- cli output ---\n' + cliOutput);
  process.exit(1);
}

// --- assertions -----------------------------------------------------------
console.log(`captured ${captured.length} requests\n`);
const byUrl = (suffix, source) =>
  captured.find((r) => r.url.endsWith(suffix) && r.source === source);

const fetchGet = byUrl('/json', 'fetch');
assert(!!fetchGet, 'fetch GET captured (source=fetch)');
assert(fetchGet?.method === 'GET', 'fetch GET method');
assert(fetchGet?.status === 200, 'fetch GET status 200');
assert(JSON.parse(fetchGet?.resBody || '{}').route === 'json', 'fetch GET response body readable');
assert(fetchGet?.reqHeaders?.authorization === '«redacted»', 'authorization header redacted');
assert(fetchGet?.reqHeaders?.['x-test'] === 'fetch-get', 'normal request header preserved');
assert(typeof fetchGet?.durationMs === 'number', 'durationMs present');

const fetchPost = captured.find((r) => r.source === 'fetch' && r.method === 'POST');
assert(!!fetchPost, 'fetch POST captured');
assert(JSON.parse(fetchPost?.reqBody || '{}').hello === 'from-fetch', 'fetch POST request body captured');
assert(JSON.parse(fetchPost?.resBody || '{}').echoed?.includes('from-fetch'), 'fetch POST response body captured');

const httpGzip = byUrl('/gzip', 'http');
assert(!!httpGzip, 'http.get captured (source=http)');
assert(httpGzip?.resHeaders?.['content-encoding'] === 'gzip', 'gzip content-encoding seen');
assert(JSON.parse(httpGzip?.resBody || '{}').compressed === true, 'gzip response body DECOMPRESSED and readable');
assert(httpGzip?.resBodyEncoding === 'utf8', 'gzip body delivered as utf8 text');

const httpPost = captured.find((r) => r.source === 'http' && r.method === 'POST');
assert(!!httpPost, 'http.request POST captured');
assert(JSON.parse(httpPost?.reqBody || '{}').hello === 'from-http', 'http POST request body captured');
assert(httpPost?.status === 200, 'http POST status 200');

// a request whose connection is dropped must be captured as state:'error'
const errored = captured.find((r) => r.url.endsWith('/boom'));
assert(!!errored, 'failed request captured');
assert(errored?.state === 'error', 'failed request marked state=error');
assert(errored?.source === 'fetch', 'failed request source=fetch');
assert(
  typeof errored?.error === 'string' && errored.error.length > 0,
  'failed request carries an error message'
);
assert(typeof errored?.durationMs === 'number', 'failed request has durationMs');

// UI is served
const ui = await fetch(`http://127.0.0.1:${portA}/`);
const uiHtml = await ui.text();
assert(ui.status === 200 && uiHtml.includes('netbridge'), 'web UI served at /');

// Vite-built assets are served with correct content types
const assetPath = (uiHtml.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
assert(!!assetPath, 'index.html references a built JS asset');
if (assetPath) {
  const asset = await fetch(`http://127.0.0.1:${portA}${assetPath}`);
  assert(asset.status === 200, 'JS asset served');
  assert((asset.headers.get('content-type') || '').includes('javascript'), 'JS asset content-type');
}

// health/discovery endpoint (used by the DevTools extension port scan)
const health = await (await fetch(`http://127.0.0.1:${portA}/api/health`)).json();
assert(health.app === 'netbridge', 'health endpoint identifies as netbridge');
assert(typeof health.version === 'string' && health.version.length > 0, 'health endpoint reports version');
assert(typeof health.requests === 'number', 'health endpoint reports request count');

// path traversal is rejected
const evil = await fetch(`http://127.0.0.1:${portA}/..%2f..%2fpackage.json`);
assert(evil.status === 404, 'path traversal rejected');

// --- port collision: when the port is busy, the instance must report and ---
// --- use its real (incremented) port — events must not leak to the blocker --
const BLOCKED_PORT = 4531;
let leakedIngests = 0;
blocker = http.createServer((req, res) => {
  if (req.url === '/ingest') leakedIngests += 1;
  res.writeHead(204).end();
});
await new Promise((r) => blocker.listen(BLOCKED_PORT, '127.0.0.1', r));

childB = spawn(
  process.execPath,
  [CLI, '--port', String(BLOCKED_PORT), '--', process.execPath, TARGET],
  {
    env: { ...process.env, TARGET_ORIGIN_PORT: String(originPort), NETBRIDGE_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let outB = '';
childB.stdout.on('data', (c) => (outB += c));
// Drain stderr too: an unconsumed pipe can fill and block child B, and its
// errors would otherwise be invisible when the collision assertions fail.
childB.stderr.on('data', (c) => (outB += c));

let portB = null;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const m = outB.match(/http:\/\/localhost:(\d+)/);
  if (m) {
    portB = Number(m[1]);
    break;
  }
}
assert(portB !== null, 'collision: instance prints a UI url');
assert(portB !== BLOCKED_PORT, `collision: printed url uses the real port (got ${portB})`);

let capturedB = null;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const list = await (await fetch(`http://127.0.0.1:${portB}/api/requests`)).json();
    if (list.length >= 4) {
      capturedB = list;
      break;
    }
  } catch {
    /* not up yet */
  }
}
assert(!!capturedB, 'collision: events arrive at the instance own collector');
assert(leakedIngests === 0, 'collision: no events leaked to the busy port');
if (childB.exitCode === null) await new Promise((r) => childB.on('exit', r));
blocker.close();

// --- teardown -------------------------------------------------------------
if (child.exitCode === null) await new Promise((r) => child.on('exit', r));
origin.close();

console.log(failures === 0 ? '\nall assertions passed' : `\n${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
