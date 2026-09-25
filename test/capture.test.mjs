/**
 * End-to-end capture: the real CLI runs a fixture that uses native fetch and
 * http.request, and the collector's /api/requests must show both stacks with
 * bodies, redaction, decompression and error capture. Also covers the UI and
 * the health endpoint.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin } from './helpers.mjs';

let origin;
let nb;
let captured;
const byUrl = (suffix, source) => captured.find((r) => r.url.endsWith(suffix) && r.source === source);

before(async () => {
  origin = await startOrigin();
  nb = await runCli({
    command: [process.execPath, path.join(FIXTURES, 'basic.mjs')],
    env: { TARGET_ORIGIN: origin.url },
  });
  captured = await nb.waitForRequests((l) => l.length >= 5 && l.every(settled), '5 settled requests');
});

after(async () => {
  await nb?.stop();
  await origin?.close();
});

describe('fetch capture', () => {
  it('captures a GET with response body and timing', () => {
    const r = byUrl('/json', 'fetch');
    assert.ok(r, 'fetch GET captured');
    assert.equal(r.method, 'GET');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.resBody).route, 'json');
    assert.equal(typeof r.durationMs, 'number');
  });

  it('redacts secrets but keeps other headers', () => {
    const r = byUrl('/json', 'fetch');
    assert.equal(r.reqHeaders.authorization, '«redacted»');
    assert.equal(r.reqHeaders['x-test'], 'fetch-get');
  });

  it('captures a POST request and response body', () => {
    const r = captured.find((x) => x.source === 'fetch' && x.method === 'POST');
    assert.ok(r);
    assert.equal(JSON.parse(r.reqBody).hello, 'from-fetch');
    assert.match(JSON.parse(r.resBody).echoed, /from-fetch/);
  });

  it('records a dropped connection as state=error', () => {
    const r = captured.find((x) => x.url.endsWith('/boom'));
    assert.ok(r);
    assert.equal(r.state, 'error');
    assert.equal(r.source, 'fetch');
    assert.ok(r.error.length > 0);
    assert.equal(typeof r.durationMs, 'number');
  });
});

describe('http capture', () => {
  it('decompresses gzip even when the consumer strips content-encoding', () => {
    const r = byUrl('/gzip', 'http');
    assert.ok(r, 'http.get captured');
    assert.equal(r.resHeaders['content-encoding'], 'gzip');
    assert.equal(r.resBodyEncoding, 'utf8');
    assert.equal(JSON.parse(r.resBody).compressed, true);
  });

  it('captures an http.request POST body', () => {
    const r = captured.find((x) => x.source === 'http' && x.method === 'POST');
    assert.ok(r);
    assert.equal(JSON.parse(r.reqBody).hello, 'from-http');
    assert.equal(r.status, 200);
  });
});

describe('collector', () => {
  it('serves the web UI and its built assets', async () => {
    const ui = await fetch(`${nb.base}/`);
    const html = await ui.text();
    assert.equal(ui.status, 200);
    assert.match(html, /netbridge/);
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset, 'index.html references a built JS asset');
    const res = await fetch(`${nb.base}${asset}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  });

  it('identifies itself on /api/health', async () => {
    const health = await (await fetch(`${nb.base}/api/health`)).json();
    assert.equal(health.app, 'netbridge');
    assert.ok(health.version.length > 0);
    assert.equal(typeof health.requests, 'number');
  });

  it('rejects path traversal', async () => {
    const res = await fetch(`${nb.base}/..%2f..%2fpackage.json`);
    assert.equal(res.status, 404);
  });
});
