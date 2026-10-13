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

const { mockMatches, normalizeMockRule, normalizeMockRules, callSteps, callKey, startedAt } = require(
  path.join(ROOT, 'dist', 'protocol.js')
);

describe('mock rule matching', () => {
  const rule = (over) => ({ id: 'r', enabled: true, method: '', url: '/users', ...over });

  it('matches a url substring, case-insensitively, for any method', () => {
    assert.equal(mockMatches(rule(), 'GET', 'https://api.test/USERS/1'), true);
    assert.equal(mockMatches(rule(), 'POST', 'https://api.test/users'), true);
    assert.equal(mockMatches(rule(), 'GET', 'https://api.test/orders'), false);
  });

  it('honors the method and the enabled flag', () => {
    assert.equal(mockMatches(rule({ method: 'POST' }), 'get', 'https://api.test/users'), false);
    assert.equal(mockMatches(rule({ method: 'POST' }), 'post', 'https://api.test/users'), true);
    assert.equal(mockMatches(rule({ enabled: false }), 'GET', 'https://api.test/users'), false);
  });

  it('treats * as a wildcard over the whole url, everything else literally', () => {
    const r = rule({ url: 'https://api.test/users/*/orders?x=(1)' });
    assert.equal(mockMatches(r, 'GET', 'https://api.test/users/42/orders?x=(1)'), true);
    assert.equal(mockMatches(r, 'GET', 'https://api.test/users/42/orders?x=1'), false);
    assert.equal(mockMatches(rule({ url: '*/users' }), 'GET', 'https://api.test/users/1'), false);
  });

  it('normalizes rules and reports the first bad one', () => {
    const r = normalizeMockRule({ url: ' /x ', method: 'post', response: { body: [1] } }, 'm9');
    assert.deepEqual(r, {
      id: 'm9',
      enabled: true,
      method: 'POST',
      url: '/x',
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '[1]' },
    });
    assert.equal(normalizeMockRule({ url: '/x', method: '*' }, 'a').method, '');
    assert.match(normalizeMockRules([{ url: '/a' }, { url: '' }]), /^rule 2: url is required/);
    assert.deepEqual(
      normalizeMockRules([{ id: 'a', url: '/a' }, { id: 'a', url: '/b' }]).map((x) => x.id),
      ['a', 'a-']
    );
  });
});

describe('call trees', () => {
  // ts is an entry's latest event: its end once settled.
  const call = (start, dur) => ({ ts: start + dur, durationMs: dur, state: 'done' });

  it('derives the start time', () => {
    assert.equal(startedAt(call(100, 50)), 100);
    assert.equal(startedAt({ ts: 100, state: 'pending' }), 100);
  });

  it('counts sequential steps', () => {
    assert.equal(callSteps([call(0, 10), call(10, 10), call(21, 5)]), 3);
    assert.equal(callSteps([call(0, 10), call(1, 10), call(2, 10)]), 1);
    assert.equal(callSteps([call(0, 10), call(2, 10), call(30, 1)]), 2);
    // A call that ends a moment after the next one starts still came first.
    assert.equal(callSteps([call(0, 10), call(9, 10)]), 2);
    assert.equal(callSteps([call(0, 75), call(71, 9)]), 2);
    // Seen on loaded machines: three calls in a row, each recorded as ending
    // after the next one started.
    assert.equal(callSteps([call(4, 148), call(144, 27), call(168, 6)]), 3);
    assert.equal(callSteps([call(20, 1473), call(1309, 563), call(1810, 292)]), 3);
    assert.equal(callSteps([call(1, 151), call(145, 31), call(167, 26)]), 3);
    // Parallel calls start together, however long they take.
    assert.equal(callSteps([call(0, 1000), call(5, 400), call(8, 990)]), 1);
    assert.equal(callSteps([call(0, 75), call(40, 9)]), 1);
    assert.equal(callSteps([{ ts: 0, state: 'pending' }, call(50, 1)]), 1);
  });

  it('keys calls by method, url and body', () => {
    const a = callKey({ method: 'POST', url: 'https://x/graphql', reqBody: '{"q":1}' });
    const b = callKey({ method: 'POST', url: 'https://x/graphql', reqBody: '{"q":2}' });
    assert.notEqual(a, b);
    assert.equal(a, callKey({ method: 'POST', url: 'https://x/graphql', reqBody: '{"q":1}' }));
  });
});
