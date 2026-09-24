/**
 * Memory bounds: the collector keeps bodies within its buffer budget, and
 * serves a large table without building one giant string (which used to pass
 * V8's max string length and crash the CLI).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { FIXTURES, runCli, startOrigin, waitFor } from './helpers.mjs';

let origin;
before(async () => {
  origin = await startOrigin();
});
after(async () => {
  await origin?.close();
});

const bigRun = (count, kb, bufferLimit, env = {}) =>
  runCli({
    command: [process.execPath, path.join(FIXTURES, 'big.mjs')],
    env: {
      TARGET_ORIGIN: origin.url,
      COUNT: String(count),
      KB: String(kb),
      NETBRIDGE_BUFFER_LIMIT: String(bufferLimit),
      ...env,
    },
  });

const doneAll = (nb) => waitFor(() => nb.output.includes('[big] all requests done'), { timeoutMs: 120_000 });

/** Read /events for `ms` and return the raw text. */
function readEvents(port, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      setTimeout(() => {
        req.destroy();
        resolve(text);
      }, ms);
    });
    req.on('error', reject);
  });
}

describe('buffer budget', () => {
  it('evicts the oldest requests once bodies pass NETBRIDGE_BUFFER_LIMIT', async () => {
    // 30 × 100 KiB against a 1 MB budget: roughly the newest 10 fit.
    const nb = await bigRun(30, 100, 1_000_000);
    try {
      await doneAll(nb);
      const list = await nb.waitForRequests((l) => l.some((r) => r.state === 'done'));
      const bodyChars = list.reduce((n, r) => n + (r.resBody?.length ?? 0), 0);
      assert.ok(list.length < 30, `older entries evicted (kept ${list.length})`);
      assert.ok(list.length >= 5, `recent entries kept (kept ${list.length})`);
      assert.ok(bodyChars <= 1_000_000, `bodies within budget (${bodyChars})`);
      const config = await (await fetch(`${nb.base}/api/config`)).json();
      assert.equal(config.bufferLimit, 1_000_000, 'the UI learns the budget');
    } finally {
      await nb.stop();
    }
  });

  it('streams the SSE backlog as several snapshot events', async () => {
    const nb = await bigRun(30, 100, 4_000_000);
    try {
      await doneAll(nb);
      await nb.waitForRequests((l) => l.length >= 30);
      const text = await readEvents(nb.port, 1000);
      const snapshots = text.match(/^event: snapshot$/gm) ?? [];
      assert.ok(snapshots.length >= 2, `backlog chunked (${snapshots.length} snapshot events)`);
      const ids = new Set();
      for (const m of text.matchAll(/^event: snapshot\ndata: (.*)$/gm)) {
        for (const r of JSON.parse(m[1])) ids.add(r.id);
      }
      assert.equal(ids.size, 30, 'every entry arrives exactly once across the chunks');
    } finally {
      await nb.stop();
    }
  });
});

// ~1.1k requests × 512 KiB: slow and memory hungry, so opt-in
// (NETBRIDGE_HEAVY_TESTS=1). Before the fix this crashed the collector with
// "RangeError: Invalid string length".
describe('large table', { skip: process.env.NETBRIDGE_HEAVY_TESTS !== '1' }, () => {
  it('serves /api/requests and /events past V8 max string length', { timeout: 300_000 }, async () => {
    const nb = await bigRun(1100, 512, 2 * 1024 * 1024 * 1024, { NETBRIDGE_BODY_LIMIT: String(600 * 1024) });
    try {
      await doneAll(nb);
      const res = await fetch(`${nb.base}/api/requests`);
      assert.equal(res.status, 200);
      let chars = 0;
      for await (const chunk of res.body) chars += chunk.length;
      assert.ok(chars > 536_870_888, `payload larger than one V8 string (${chars})`);
      await readEvents(nb.port, 2000);
      const health = await (await fetch(`${nb.base}/api/health`)).json();
      assert.equal(health.requests, 1100, 'collector still alive and complete');
    } finally {
      await nb.stop();
    }
  });
});
