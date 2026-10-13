/**
 * Mock rules: the API validates and stores them, the app processes pick them
 * up live, and fetch and http calls get the canned response, a delay, or a
 * network error. `--mocks <file>` loads rules and saves changes back.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin, waitFor } from './helpers.mjs';

const json = (body, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function startApp(origin, args = []) {
  const nb = await runCli({ args, command: [process.execPath, path.join(FIXTURES, 'app.mjs')], env: { TARGET_ORIGIN: origin.url } });
  const health = await waitFor(
    async () => {
      const h = await (await fetch(`${nb.base}/api/health`)).json();
      return h.ports?.length ? h : null;
    },
    { label: 'app port' }
  );
  return { nb, app: `http://127.0.0.1:${health.ports[0]}` };
}

describe('mock rules', () => {
  let origin;
  let nb;
  let app;
  before(async () => {
    origin = await startOrigin();
    ({ nb, app } = await startApp(origin));
  });
  after(async () => {
    await nb?.stop();
    await origin?.close();
  });

  it('rejects malformed rules', async () => {
    for (const [rule, error] of [
      [{}, /url is required/],
      [{ url: '/x', response: { status: 99 } }, /status/],
      [{ url: '/x', response: { status: 200 }, fail: 'down' }, /responds or fails/],
      [{ url: '/x', response: { headers: { 'bad name': 'v' } } }, /header name/],
      [{ url: '/x', delayMs: -1 }, /delayMs/],
    ]) {
      const res = await fetch(`${nb.base}/api/mocks`, json(rule));
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, error);
    }
    assert.equal((await fetch(`${nb.base}/api/mocks`, { method: 'POST', body: '{}' })).status, 415);
  });

  it('answers fetch and http calls with the rule response', async () => {
    const res = await fetch(
      `${nb.base}/api/mocks`,
      json({ url: '/mock-me', response: { status: 201, headers: { 'x-mock': 'yes', 'content-length': '999' }, body: { mocked: true } } })
    );
    const rule = await res.json();
    assert.equal(rule.id, 'm1');
    assert.equal(rule.enabled, true);
    // JSON bodies are stored as text, framing headers dropped.
    assert.equal(rule.response.body, '{"mocked":true}');
    assert.equal(rule.response.headers['content-type'], 'application/json');
    assert.equal(rule.response.headers['content-length'], undefined);

    const got = await waitFor(
      async () => {
        const body = JSON.parse(await (await fetch(`${app}/mocked`)).text());
        return body.fetch.status === 201 ? body : null;
      },
      { label: 'mocked answers' }
    );
    assert.deepEqual(got.fetch, { status: 201, body: '{"mocked":true}' });
    assert.deepEqual(got.http, { status: 201, body: '{"mocked":true}' });

    const list = await nb.waitForRequests((l) => l.filter((e) => e.mocked === 'm1' && e.state === 'done').length >= 2);
    const viaHttp = list.find((e) => e.mocked === 'm1' && e.source === 'http');
    assert.match(viaHttp.url, /\/mock-me$/);
    assert.equal(viaHttp.reqHeaders['x-netbridge-token'], undefined);
    assert.equal(viaHttp.resHeaders['x-mock'], 'yes');
    // Nothing reached the real backend for these.
  });

  it('fails calls with a fail rule', async () => {
    await fetch(`${nb.base}/api/mocks`, json({ id: 'down', url: '*/json?fail', fail: 'backend down' }));
    const text = await waitFor(
      async () => {
        const t = await (await fetch(`${app}/fail`)).text();
        return t.startsWith('failed') ? t : null;
      },
      { label: 'failed call' }
    );
    assert.equal(text, 'failed: backend down');
    const list = await nb.waitForRequests((l) => l.some((e) => e.mocked === 'down' && e.state === 'error'));
    assert.match(list.find((e) => e.mocked === 'down').error, /backend down/);
  });

  it('delays calls with a delay rule and still reaches the backend', async () => {
    await fetch(`${nb.base}/api/mocks`, json({ id: 'slow', method: 'get', url: '/json', delayMs: 300 }));
    // The rule list reaches the app process over its stream: time a page
    // whose three calls all carry the rule, so all three were held back.
    const elapsed = await waitFor(
      async () => {
        const t0 = Date.now();
        assert.equal(await (await fetch(`${app}/page`)).text(), 'page done');
        const ms = Date.now() - t0;
        const list = await nb.waitForRequests((l) => l.every(settled), 'calls settled');
        const page = list.filter((e) => e.source === 'inbound' && e.url.endsWith('/page')).pop();
        const calls = list.filter((e) => e.parentId === page?.id);
        return calls.length === 3 && calls.every((c) => c.mocked === 'slow') ? ms : null;
      },
      { label: 'a /page whose calls all met the delay rule' }
    );
    // Three calls in sequence, each held back 300 ms.
    assert.ok(elapsed >= 850, `took ${elapsed} ms`);
  });

  it('mocks a POST that carries an Origin header', async () => {
    assert.equal(await (await fetch(`${app}/origin-post`)).text(), '201 {"mocked":true}');
  });

  it('never sends a call a delayed fail rule answers', async () => {
    await fetch(`${nb.base}/api/mocks`, json({ id: 'nopost', method: 'POST', url: '/echo', fail: 'gone', delayMs: 150 }));
    await new Promise((r) => setTimeout(r, 200));
    assert.match(await (await fetch(`${app}/http-post`)).text(), /^error .*gone/);
    const list = await nb.waitForRequests((l) => l.some((e) => e.mocked === 'nopost' && e.state === 'error'));
    const call = list.find((e) => e.mocked === 'nopost');
    // The origin's /echo never saw it: no entry answered by the real server.
    assert.equal(call.status, undefined);
    await fetch(`${nb.base}/api/mocks/nopost`, { method: 'DELETE' });
  });

  it('refuses header values Node cannot send', async () => {
    const res = await fetch(`${nb.base}/api/mocks`, json({ url: '/x', response: { headers: { 'x-note': 'café →' } } }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /invalid header value/);
  });

  it('disables, lists and deletes rules', async () => {
    const rules = await (await fetch(`${nb.base}/api/mocks`)).json();
    assert.deepEqual(rules.map((r) => r.id), ['m1', 'down', 'slow']);
    assert.equal(rules[2].method, 'GET');
    await fetch(`${nb.base}/api/mocks`, json({ ...rules[0], enabled: false }));
    assert.equal((await fetch(`${nb.base}/api/mocks/slow`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${nb.base}/api/mocks/slow`, { method: 'DELETE' })).status, 404);
    const body = await waitFor(
      async () => {
        const b = JSON.parse(await (await fetch(`${app}/mocked`)).text());
        return b.fetch.status === 404 ? b : null;
      },
      { label: 'disabled rule lets calls through' }
    );
    assert.equal(body.http.status, 404);
  });

  it('replaces the whole list with PUT', async () => {
    const res = await fetch(`${nb.base}/api/mocks`, json([{ url: '/a' }, { url: '/b', fail: true }], 'PUT'));
    const rules = await res.json();
    assert.deepEqual(rules.map((r) => r.id), ['m1', 'm2']);
    assert.equal(rules[1].fail, 'mocked network failure');
  });

  it('keeps the rule stream to the app processes only', async () => {
    assert.equal((await fetch(`${nb.base}/api/mocks/stream`)).status, 401);
    assert.equal((await fetch(`${nb.base}/__mock/m1`)).status, 401);
  });
});

describe('--mocks file', () => {
  let origin;
  let dir;
  before(async () => {
    origin = await startOrigin();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-mocks-'));
  });
  after(async () => {
    await origin?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies rules from the file from the first call, and saves changes', async () => {
    const file = path.join(dir, 'mocks.json');
    fs.writeFileSync(file, JSON.stringify([{ url: '/mock-me', response: { status: 202, body: 'from file' } }]));
    const { nb, app } = await startApp(origin, ['--mocks', file]);
    try {
      const body = JSON.parse(await (await fetch(`${app}/mocked`)).text());
      assert.deepEqual(body.http, { status: 202, body: 'from file' });
      assert.deepEqual(body.fetch, { status: 202, body: 'from file' });
      assert.match(nb.output, /mocks: 1 of 1 rule\(s\) enabled/);

      await fetch(`${nb.base}/api/mocks`, json({ url: '/added', delayMs: 10 }));
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(saved.map((r) => r.url), ['/mock-me', '/added']);
    } finally {
      await nb.stop();
    }
  });

  it('refuses to start with an invalid file', async () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify([{ response: {} }]));
    const nb = await runCli({ args: ['--mocks', file], command: [process.execPath, '-e', ''], waitForUrl: false });
    const { code } = await nb.exited;
    assert.equal(code, 1);
    assert.match(nb.output, /rule 1: url is required/);
  });
});
