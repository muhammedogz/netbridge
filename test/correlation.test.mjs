/**
 * Inbound correlation: calls made while the app's server handles a request
 * carry that request as their parent, the inbound entry is recorded, and the
 * app's listening port shows up in /api/health. Also the /api/requests query
 * filters, undici capture and the --overlay script tag.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin, waitFor } from './helpers.mjs';

let origin;
let nb;
let app;

before(async () => {
  origin = await startOrigin();
  nb = await runCli({
    args: ['--overlay'],
    command: [process.execPath, path.join(FIXTURES, 'app.mjs')],
    env: { TARGET_ORIGIN: origin.url },
  });
  const health = await waitFor(
    async () => {
      const h = await (await fetch(`${nb.base}/api/health`)).json();
      return h.ports?.length ? h : null;
    },
    { label: 'app port in /api/health' }
  );
  app = `http://127.0.0.1:${health.ports[0]}`;
});

after(async () => {
  await nb?.stop();
  await origin?.close();
});

const inboundFor = (list, suffix) => list.find((e) => e.source === 'inbound' && e.url.endsWith(suffix));

describe('inbound correlation', () => {
  let list;
  before(async () => {
    assert.equal(await (await fetch(`${app}/page`)).text(), 'page done');
    list = await nb.waitForRequests((l) => {
      const page = inboundFor(l, '/page');
      return page && settled(page) && l.filter((e) => e.parentId === page.id && settled(e)).length === 3;
    }, 'the /page request and its 3 calls');
  });

  it('records the inbound request with its status and timing', () => {
    const page = inboundFor(list, '/page');
    assert.equal(page.method, 'GET');
    assert.equal(page.status, 200);
    assert.equal(typeof page.durationMs, 'number');
    assert.equal(page.resHeaders['content-type'], 'text/plain');
  });

  it('links fetch and http calls to the request that made them', () => {
    const page = inboundFor(list, '/page');
    const calls = list.filter((e) => e.parentId === page.id);
    assert.deepEqual(calls.map((c) => c.source).sort(), ['fetch', 'fetch', 'http']);
  });

  it('serves one parent\'s calls through ?parent= and summaries without bodies', async () => {
    const page = inboundFor(list, '/page');
    const res = await fetch(`${nb.base}/api/requests?parent=${page.id}&summary=1`);
    const calls = await res.json();
    assert.equal(calls.length, 3);
    assert.equal(calls[0].resBody, undefined);
    assert.equal(typeof calls[0].key, 'string');
    // The two identical fetches share a key; the http call differs by url.
    assert.equal(new Set(calls.map((c) => c.key)).size, 2);
  });

  it('serves one entry by id', async () => {
    const page = inboundFor(list, '/page');
    const one = await (await fetch(`${nb.base}/api/requests/${page.id}`)).json();
    assert.equal(one.id, page.id);
    assert.equal((await fetch(`${nb.base}/api/requests/nope`)).status, 404);
  });

  it('filters by source and limits to the newest', async () => {
    const inbound = await (await fetch(`${nb.base}/api/requests?source=inbound&limit=1`)).json();
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].source, 'inbound');
  });

  it('does not record inbound requests that make no calls', async () => {
    await fetch(`${app}/missing`);
    const all = await nb.requests();
    assert.equal(all.some((e) => e.url.endsWith('/missing')), false);
  });
});

describe('streaming responses', () => {
  it('shows a call with its status while the body is still coming', async () => {
    const done = fetch(`${app}/stream`).then((r) => r.text());
    const live = await waitFor(
      async () => {
        const list = await nb.requests();
        return list.find((e) => e.url.endsWith('/slow') && e.state === 'pending' && e.status === 200);
      },
      { label: 'a pending /slow entry with its status', timeoutMs: 5000, intervalMs: 50 }
    );
    assert.equal(typeof live.ttfbMs, 'number');
    assert.equal(live.resHeaders['content-type'], 'text/plain');
    assert.equal(await done, 'xxxxxxxxxx');
    const list = await nb.waitForRequests((l) => l.some((e) => e.id === live.id && settled(e)), 'the /slow call settled');
    const ended = list.find((e) => e.id === live.id);
    assert.equal(ended.state, 'done');
    // The entry keeps its start time: ts is the end once settled.
    assert.ok(ended.ts - ended.durationMs <= live.ts + 1);
  });
});

describe('calls after the response', () => {
  it('keeps a call made right away and drops one from a much later timer', async () => {
    assert.equal(await (await fetch(`${app}/later`)).text(), 'sent');
    const list = await nb.waitForRequests(
      (l) => l.some((e) => e.url.endsWith('?late') && settled(e)) && l.some((e) => e.url.endsWith('?soon') && settled(e)),
      'both calls of /later'
    );
    const later = inboundFor(list, '/later');
    assert.ok(later, 'the /later request is recorded');
    assert.equal(list.find((e) => e.url.endsWith('?soon')).parentId, later.id);
    assert.equal(list.find((e) => e.url.endsWith('?late')).parentId, undefined);
  });
});

describe('undici', () => {
  // undici 8 needs Node 22.19+; its response bodies come from 7.x channels.
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 19);

  it('captures undici.request() calls with their parent', { skip: !supported && 'needs Node 22.19+' }, async () => {
    assert.match(await (await fetch(`${app}/undici`)).text(), /"route":"json"/);
    const list = await nb.waitForRequests(
      (l) => l.some((e) => e.source === 'undici' && settled(e)),
      'a settled undici entry'
    );
    const call = list.find((e) => e.source === 'undici');
    const parent = inboundFor(list, '/undici');
    assert.equal(call.parentId, parent.id);
    assert.equal(call.status, 200);
    assert.equal(JSON.parse(call.resBody).route, 'json');
    // Node's own fetch is undici too, but is captured once, as fetch.
    assert.equal(list.filter((e) => e.source === 'undici').length, 1);
  });
});

describe('--overlay', () => {
  it('appends the bubble script to HTML documents', async () => {
    const res = await fetch(`${app}/html`, { headers: { 'sec-fetch-dest': 'document', 'accept-encoding': 'gzip' } });
    const html = await res.text();
    assert.equal(res.headers.get('content-length'), null);
    assert.match(html, /<h1>app<\/h1><\/body><\/html><script src="http:\/\/127\.0\.0\.1:\d+\/overlay\.js" data-trace="[^"]+" async><\/script>$/);
    const trace = html.match(/data-trace="([^"]+)"/)[1];
    // The trace is the page's inbound id: its calls are grouped under it.
    const list = await nb.waitForRequests((l) => l.some((e) => e.parentId === trace), 'calls of the page');
    assert.ok(list.find((e) => e.id === trace && e.source === 'inbound'));
  });

  it('leaves other responses alone', async () => {
    const res = await fetch(`${app}/html`);
    const html = await res.text();
    assert.doesNotMatch(html, /overlay\.js/);
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html));
  });

  it('survives a second end() and skips non-200 pages', async () => {
    const doc = { headers: { 'sec-fetch-dest': 'document' } };
    const twice = await (await fetch(`${app}/html-twice`, doc)).text();
    assert.equal((twice.match(/overlay\.js/g) || []).length, 1);
    const missing = await fetch(`${app}/html-404`, doc);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /overlay\.js/);
    // The app is still up.
    assert.equal(await (await fetch(`${app}/page`)).text(), 'page done');
  });

  it('serves the overlay script and page', async () => {
    const js = await fetch(`${nb.base}/overlay.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${nb.base}/overlay.html`)).status, 200);
  });
});
