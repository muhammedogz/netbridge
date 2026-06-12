/**
 * netbridge smoke test — runs the real CLI against a fixture target and
 * asserts on the collector's /api/requests output.
 *
 * Covers: fetch GET/POST, http.get (gzip decompression), http.request POST,
 * header redaction, request/response body capture, both sources.
 */
import { spawn } from 'child_process';
import http from 'http';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'dist', 'cli.js');
const TARGET = path.join(__dirname, 'fixtures', 'target.mjs');
const NB_PORT = 4521;

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

// --- poll collector until all 4 requests are done -----------------------
async function fetchRequests() {
  try {
    const res = await fetch(`http://127.0.0.1:${NB_PORT}/api/requests`);
    return await res.json();
  } catch {
    return null;
  }
}

let captured = null;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const list = await fetchRequests();
  if (list && list.length >= 4 && list.every((r) => r.state === 'done')) {
    captured = list;
    break;
  }
}

if (!captured) {
  console.error('FAIL  did not capture 4 completed requests in time');
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

// UI is served
const ui = await fetch(`http://127.0.0.1:${NB_PORT}/`);
const uiHtml = await ui.text();
assert(ui.status === 200 && uiHtml.includes('netbridge'), 'web UI served at /');

// Vite-built assets are served with correct content types
const assetPath = (uiHtml.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
assert(!!assetPath, 'index.html references a built JS asset');
if (assetPath) {
  const asset = await fetch(`http://127.0.0.1:${NB_PORT}${assetPath}`);
  assert(asset.status === 200, 'JS asset served');
  assert((asset.headers.get('content-type') || '').includes('javascript'), 'JS asset content-type');
}

// health/discovery endpoint (used by the DevTools extension port scan)
const health = await (await fetch(`http://127.0.0.1:${NB_PORT}/api/health`)).json();
assert(health.app === 'netbridge', 'health endpoint identifies as netbridge');
assert(typeof health.version === 'string' && health.version.length > 0, 'health endpoint reports version');

// path traversal is rejected
const evil = await fetch(`http://127.0.0.1:${NB_PORT}/..%2f..%2fpackage.json`);
assert(evil.status === 404, 'path traversal rejected');

// --- port collision: when the port is busy, the instance must report and ---
// --- use its real (incremented) port — events must not leak to the blocker --
const BLOCKED_PORT = 4531;
let leakedIngests = 0;
const blocker = http.createServer((req, res) => {
  if (req.url === '/ingest') leakedIngests += 1;
  res.writeHead(204).end();
});
await new Promise((r) => blocker.listen(BLOCKED_PORT, '127.0.0.1', r));

const childB = spawn(
  process.execPath,
  [CLI, '--port', String(BLOCKED_PORT), '--', process.execPath, TARGET],
  {
    env: { ...process.env, TARGET_ORIGIN_PORT: String(originPort), NETBRIDGE_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let outB = '';
childB.stdout.on('data', (c) => (outB += c));

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
