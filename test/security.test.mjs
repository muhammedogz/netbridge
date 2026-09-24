/**
 * The collector listens on 127.0.0.1, but any web page the developer has
 * open can still reach it through the browser. These cases replay what such a
 * page can do: CORS "simple" POSTs that skip the preflight, and DNS
 * rebinding, where the page's own hostname resolves to 127.0.0.1.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin } from './helpers.mjs';

let origin;
let nb;

/** A raw request, so Host and Origin can be set freely (fetch forbids Host). */
function raw(method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: nb.port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const FAKE = JSON.stringify({
  id: 'injected-1',
  phase: 'end',
  ts: 1,
  pid: 1,
  source: 'fetch',
  method: 'GET',
  url: 'https://attacker.example/pwn',
  status: 200,
});

before(async () => {
  origin = await startOrigin();
  nb = await runCli({
    command: [process.execPath, path.join(FIXTURES, 'basic.mjs')],
    env: { TARGET_ORIGIN: origin.url },
  });
  await nb.waitForRequests((l) => l.length >= 5 && l.every(settled));
});

after(async () => {
  await nb?.stop();
  await origin?.close();
});

describe('/ingest', () => {
  it('rejects a drive-by text/plain POST from a web page', async () => {
    const res = await raw('POST', '/ingest', { origin: 'https://evil.example', 'content-type': 'text/plain' }, FAKE);
    assert.equal(res.status, 403);
    assert.ok(!(await nb.requests()).some((r) => r.id === 'injected-1'), 'fake entry not stored');
  });

  it('rejects a POST without the per-run token', async () => {
    const res = await raw('POST', '/ingest', { 'content-type': 'application/x-ndjson' }, FAKE);
    assert.equal(res.status, 401);
  });

  it('rejects a wrong token', async () => {
    const res = await raw('POST', '/ingest', { 'x-netbridge-token': 'guess' }, FAKE);
    assert.equal(res.status, 401);
  });
});

describe('DNS rebinding', () => {
  for (const urlPath of ['/api/requests', '/events', '/', '/api/config']) {
    it(`refuses ${urlPath} for a foreign Host`, async () => {
      const res = await raw('GET', urlPath, { host: `rebind.evil.example:${nb.port}` });
      assert.equal(res.status, 403);
      assert.ok(!res.body.includes('super-secret') && !res.body.includes('/json'), 'no captured data leaked');
    });
  }

  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    it(`serves Host ${host}`, async () => {
      const res = await raw('GET', '/api/health', { host: `${host}:${nb.port}` });
      assert.equal(res.status, 200);
    });
  }
});

describe('/api/clear', () => {
  it('rejects a cross-site POST', async () => {
    const res = await raw('POST', '/api/clear', { origin: 'https://evil.example', 'content-type': 'text/plain' });
    assert.equal(res.status, 403);
    assert.ok((await nb.requests()).length >= 5, 'buffer untouched');
  });

  it('rejects another local origin (a different dev server on this machine)', async () => {
    const res = await raw('POST', '/api/clear', { origin: 'http://localhost:3000' });
    assert.equal(res.status, 403);
  });
});

describe('/api/resend', () => {
  it('rejects another local origin', async () => {
    const res = await raw(
      'POST',
      '/api/resend',
      { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      JSON.stringify({ method: 'GET', url: `${origin.url}/json` })
    );
    assert.equal(res.status, 403);
  });
});

describe('the UI itself', () => {
  it('may clear from its own origin', async () => {
    const res = await raw('POST', '/api/clear', { origin: `http://localhost:${nb.port}` });
    assert.equal(res.status, 204);
  });
});
