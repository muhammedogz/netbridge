/**
 * Capture edge cases: timing semantics shared by both wrappers, bounded
 * capture of Request bodies, and urls for IPv6 hosts and unix sockets.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FIXTURES, runCli, settled, startOrigin, waitFor } from './helpers.mjs';

const BODY_LIMIT = 64 * 1024;
let origin;
let nb;
let captured;
const byCase = (name) => captured.find((r) => r.url.includes(`case=${name}`));

before(async () => {
  origin = await startOrigin();
  nb = await runCli({
    command: [process.execPath, path.join(FIXTURES, 'edge.mjs')],
    env: { TARGET_ORIGIN: origin.url, NETBRIDGE_BODY_LIMIT: String(BODY_LIMIT) },
  });
  await waitFor(() => nb.output.includes('[edge] all requests done'), { timeoutMs: 20_000 });
  // The fixture's last events may still be in flight when it reports done.
  const expected = [
    'slow-fetch',
    'slow-http',
    'request-string',
    'request-stream',
    'formdata',
    'blob',
    'init-stream',
    'init-stream-small',
  ];
  if (process.platform !== 'win32') expected.push('unix');
  if (!nb.output.includes('no ipv6 loopback')) expected.push('ipv6');
  captured = await nb.waitForRequests(
    (l) => l.every(settled) && expected.every((c) => l.some((r) => r.url.includes(`case=${c}`))),
    `cases ${expected.join(', ')}`
  );
});

after(async () => {
  await nb?.stop();
  await origin?.close();
});

describe('timing', () => {
  it('fetch and http both measure until the body is done', () => {
    const f = byCase('slow-fetch');
    const h = byCase('slow-http');
    assert.ok(f && h);
    // /slow sends headers at once and the body over ~1s.
    assert.ok(f.durationMs >= 800, `fetch durationMs ${f.durationMs}`);
    assert.ok(h.durationMs >= 800, `http durationMs ${h.durationMs}`);
  });
});

describe('Request bodies', () => {
  for (const name of ['request-string', 'request-stream']) {
    it(`${name}: captured up to the limit, sent whole`, () => {
      const r = byCase(name);
      assert.ok(r, 'captured');
      assert.equal(r.reqBody.length, BODY_LIMIT);
      assert.equal(r.reqBodyTruncated, true);
      const size = name === 'request-string' ? 3 * 1024 * 1024 : 48 * 64 * 1024;
      assert.match(nb.output, new RegExp(`${name} echoed ${size}\\b`), 'origin got every byte');
    });
  }
});

describe('init bodies', () => {
  it('FormData: captured as multipart, fields and files included', () => {
    const r = byCase('formdata');
    assert.ok(r?.reqBody, 'body captured');
    assert.match(r.reqBody, /name="hello"\r\n\r\nworld/);
    assert.match(r.reqBody, /filename="x\.txt"/);
    assert.match(r.reqBody, /file-contents/);
  });

  it('Blob: captured', () => {
    assert.equal(byCase('blob')?.reqBody, 'blob-body');
  });

  it('ReadableStream: captured up to the limit, sent whole', () => {
    const r = byCase('init-stream');
    assert.equal(r.reqBody.length, BODY_LIMIT);
    assert.equal(r.reqBodyTruncated, true);
    assert.match(nb.output, new RegExp(`init-stream echoed ${48 * 64 * 1024}\\b`), 'origin got every byte');
  });

  it('small ReadableStream: captured whole, not truncated', () => {
    const r = byCase('init-stream-small');
    assert.equal(r.reqBody, 'qqq');
    assert.ok(!r.reqBodyTruncated);
    assert.match(nb.output, /init-stream-small echoed qqq/);
  });
});

describe('urls', () => {
  it('brackets an IPv6 host', (t) => {
    if (nb.output.includes('no ipv6 loopback')) return t.skip('no ipv6 loopback');
    const r = byCase('ipv6');
    assert.ok(r, 'captured');
    assert.match(r.url, /^http:\/\/\[::1\]:\d+\/v6\?case=ipv6$/);
  });

  it('names the socket for unix-socket requests', { skip: process.platform === 'win32' }, () => {
    const r = byCase('unix');
    assert.ok(r, 'captured');
    assert.match(r.url, /^http:\/\/unix:\/.+s\.sock:\/containers\/json\?case=unix$/);
    assert.equal(r.status, 200);
  });
});
