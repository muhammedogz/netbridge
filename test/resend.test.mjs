/**
 * Request replay: POST /api/resend as-is, edited, with redacted headers, on
 * network failure, and its payload validation and CSRF guards.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin } from './helpers.mjs';

let origin;
let nb;
let fetchGet;
let fetchPost;

const resend = (payload, headers = {}) =>
  fetch(`${nb.base}/api/resend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

before(async () => {
  origin = await startOrigin();
  nb = await runCli({
    command: [process.execPath, path.join(FIXTURES, 'basic.mjs')],
    env: { TARGET_ORIGIN: origin.url },
  });
  const list = await nb.waitForRequests((l) => l.length >= 5 && l.every(settled));
  fetchGet = list.find((r) => r.url.endsWith('/json') && r.source === 'fetch');
  fetchPost = list.find((r) => r.source === 'fetch' && r.method === 'POST');
});

after(async () => {
  await nb?.stop();
  await origin?.close();
});

describe('resend', () => {
  it('re-sends as-is and returns the settled replay entry', async () => {
    const before = (await nb.requests()).length;
    const res = await resend({ id: fetchPost.id });
    assert.equal(res.status, 200);
    const entry = await res.json();
    assert.equal(entry.state, 'done');
    assert.equal(entry.source, 'replay');
    assert.equal(entry.replayOf, fetchPost.id);
    assert.match(JSON.parse(entry.resBody).echoed, /from-fetch/);
    assert.equal((await nb.requests()).length, before + 1);
  });

  it('sends an edited body', async () => {
    const entry = await (await resend({ id: fetchPost.id, body: '{"hello":"edited"}' })).json();
    assert.match(JSON.parse(entry.resBody).echoed, /edited/);
  });

  it('drops redacted headers and keeps the rest', async () => {
    const entry = await (await resend({ id: fetchGet.id })).json();
    assert.equal(entry.state, 'done');
    assert.ok(!('authorization' in entry.reqHeaders));
    assert.equal(entry.reqHeaders['x-test'], 'fetch-get');
  });

  it('records a network failure as state=error', async () => {
    const entry = await (await resend({ id: fetchGet.id, url: `${origin.url}/boom` })).json();
    assert.equal(entry.state, 'error');
    assert.ok(entry.error.length > 0);
  });

  it('body:null resends without a body', async () => {
    const entry = await (await resend({ id: fetchPost.id, body: null })).json();
    assert.equal(entry.state, 'done');
    assert.equal(entry.reqBody, undefined);
  });
});

describe('resend validation', () => {
  it('404s an unknown id', async () => {
    assert.equal((await resend({ id: 'nope' })).status, 404);
  });

  it('400s a non-http url and a missing url', async () => {
    assert.equal((await resend({ method: 'GET', url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await resend({ method: 'GET' })).status, 400);
  });

  it('400s bad header names, non-primitive header values and non-string bodies', async () => {
    assert.equal((await resend({ id: fetchPost.id, headers: { 'bad name': 'x' } })).status, 400);
    assert.equal((await resend({ id: fetchPost.id, headers: { 'x-ok': { nested: true } } })).status, 400);
    assert.equal((await resend({ id: fetchPost.id, body: { a: 1 } })).status, 400);
  });

  it('415s a non-json content-type', async () => {
    const res = await fetch(`${nb.base}/api/resend`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id: fetchPost.id }),
    });
    assert.equal(res.status, 415);
  });

  it('403s a foreign Origin and allows the local one', async () => {
    assert.equal((await resend({ id: fetchPost.id }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await resend({ id: fetchPost.id }, { origin: nb.base })).status, 200);
  });
});
