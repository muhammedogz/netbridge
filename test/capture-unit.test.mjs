/**
 * Unit tests for capture-layer helpers, loaded from the build. Requiring these
 * modules patches nothing (only patchHttp/patchFetch do) and, without
 * NETBRIDGE_PORT, emits nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { ROOT } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { buildUrl } = require(path.join(ROOT, 'dist', 'capture', 'http.js'));
const { mergeEvent, entrySize } = require(path.join(ROOT, 'dist', 'protocol.js'));

describe('buildUrl', () => {
  const cases = [
    ['string url', 'http', ['http://a.test/x?y=1'], 'http://a.test/x?y=1', 'GET'],
    ['URL + options', 'https', [new URL('https://a.test/x'), { method: 'post' }], 'https://a.test/x', 'POST'],
    ['options, default port dropped', 'https', [{ host: 'a.test', port: 443, path: '/p' }], 'https://a.test/p', 'GET'],
    ['options, custom port kept', 'http', [{ hostname: 'a.test', port: 8080, path: '/p' }], 'http://a.test:8080/p', 'GET'],
    ['options.protocol wins', 'http', [{ protocol: 'https:', host: 'a.test' }], 'https://a.test/', 'GET'],
    ['IPv6 literal gets brackets', 'http', [{ host: '::1', port: 3000, path: '/v6' }], 'http://[::1]:3000/v6', 'GET'],
    ['bracketed IPv6 kept', 'http', [{ hostname: '[::1]', port: 3000 }], 'http://[::1]:3000/', 'GET'],
    [
      'unix socket',
      'http',
      [{ socketPath: '/var/run/docker.sock', path: '/containers/json' }],
      'http://unix:/var/run/docker.sock:/containers/json',
      'GET',
    ],
    ['no host defaults to localhost', 'http', [{ path: '/p' }], 'http://localhost/p', 'GET'],
  ];
  for (const [label, protocol, args, url, method] of cases) {
    it(label, () => assert.deepEqual(buildUrl(protocol, args), { url, method }));
  }
});

describe('mergeEvent', () => {
  it('folds start and end into one entry with a state', () => {
    let e = mergeEvent(undefined, { id: 'a', phase: 'start', method: 'GET', url: 'http://x/' });
    assert.equal(e.state, 'pending');
    e = mergeEvent(e, { id: 'a', phase: 'end', status: 200 });
    assert.equal(e.state, 'done');
    assert.equal(e.method, 'GET');
    assert.equal(e.status, 200);
  });

  it('keeps the error state and ignores unknown keys', () => {
    const e = mergeEvent(undefined, JSON.parse('{"id":"b","phase":"error","error":"x","__proto__":{"polluted":1},"junk":1}'));
    assert.equal(e.state, 'error');
    assert.equal(e.junk, undefined);
    assert.equal(e.polluted, undefined);
    assert.equal(Object.getPrototypeOf(e), Object.prototype);
  });
});

describe('entrySize', () => {
  it('counts bodies and headers', () => {
    const small = entrySize({ url: 'http://x/' });
    const big = entrySize({ url: 'http://x/', resBody: 'a'.repeat(1000), reqHeaders: { k: 'v'.repeat(100) } });
    assert.ok(big - small >= 1100);
  });
});

describe('quoting', () => {
  const { quoteNodeOption, quoteWindowsArg } = require(path.join(ROOT, 'dist', 'quote.js'));

  it('escapes backslashes and quotes for NODE_OPTIONS', () => {
    assert.equal(quoteNodeOption('C:\\Users\\me\\preload.js'), '"C:\\\\Users\\\\me\\\\preload.js"');
    assert.equal(quoteNodeOption('/a "b"/c'), '"/a \\"b\\"/c"');
  });

  const win = [
    ['plain', 'next', 'next'],
    ['empty', '', '""'],
    ['spaces', 'a b', '"a b"'],
    ['cmd metachars', 'a&b', '"a&b"'],
    ['inner quote', 'say "hi"', '"say \\"hi\\""'],
    ['backslashes before a quote', 'a\\"b', '"a\\\\\\"b"'],
    ['trailing backslash', 'C:\\dir with space\\', '"C:\\dir with space\\\\"'],
    ['backslash path, no quoting needed', 'C:\\dir\\x.mjs', 'C:\\dir\\x.mjs'],
  ];
  for (const [label, input, expected] of win) {
    it(`windows arg: ${label}`, () => assert.equal(quoteWindowsArg(input), expected));
  }
});
