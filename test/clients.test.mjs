/**
 * Real clients: axios, got and node-fetch run on http.request, ky on fetch.
 * Each must be captured once, from the right wrapper, with readable bodies.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin } from './helpers.mjs';

let origin;
let nb;
let captured;
const CLIENTS = {
  axios: { source: 'http', route: '/gzip' },
  got: { source: 'http', route: '/gzip' },
  'node-fetch': { source: 'http', route: '/gzip' },
  ky: { source: 'fetch', route: '/json' },
};
const byClient = (name) => captured.filter((r) => r.url.endsWith(`client=${name}`));

before(async () => {
  origin = await startOrigin();
  nb = await runCli({
    command: [process.execPath, path.join(FIXTURES, 'clients.mjs')],
    env: { TARGET_ORIGIN: origin.url },
  });
  captured = await nb.waitForRequests((l) => l.length >= 7 && l.every(settled), '7 settled client requests');
});

after(async () => {
  await nb?.stop();
  await origin?.close();
});

describe('clients', () => {
  for (const [name, { source, route }] of Object.entries(CLIENTS)) {
    it(`${name}: captured once via ${source} with a readable body`, () => {
      const hits = byClient(name);
      assert.equal(hits.length, 1, `exactly one capture (got ${hits.length})`);
      const [r] = hits;
      assert.equal(r.source, source);
      assert.equal(r.status, 200);
      assert.ok(r.url.includes(route));
      assert.equal(r.resBodyEncoding, 'utf8');
      assert.ok(JSON.parse(r.resBody), 'response body is JSON text, not compressed bytes');
    });
  }

  for (const name of ['axios', 'got', 'ky']) {
    it(`${name}: POST body captured`, () => {
      const [r] = byClient(`${name}-post`);
      assert.ok(r);
      assert.equal(r.method, 'POST');
      assert.equal(JSON.parse(r.reqBody).from, name);
    });
  }
});
