/**
 * "copy as MSW handler / nock" (ui-src/src/testcode.ts): the generated test
 * doubles. The module is transpiled with the TypeScript compiler and loaded
 * from memory, its protocol import pointed at the built dist/protocol.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import ts from 'typescript';
import { ROOT } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { outputText } = ts.transpileModule(fs.readFileSync(path.join(ROOT, 'ui-src', 'src', 'testcode.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', outputText)(
  (id) => (id.endsWith('src/protocol') ? require(path.join(ROOT, 'dist', 'protocol.js')) : require(id)),
  mod,
  mod.exports
);
const { formatMswHandler, formatNock } = mod.exports;

const created = {
  method: 'POST',
  url: 'https://api.test/v1/orders?tenant=a&tag=x&tag=y',
  state: 'done',
  status: 201,
  reqBody: '{"qty":2}',
  resHeaders: { 'content-type': 'application/json', 'x-request-id': 'r-1', 'content-length': '16', authorization: '«redacted»' },
  resBody: '{"id":7,"qty":2}',
};

describe('MSW handler', () => {
  it('answers with the captured JSON, status and headers', () => {
    const code = formatMswHandler(created);
    assert.match(code, /http\.post\("https:\/\/api\.test\/v1\/orders", \(\) =>/);
    assert.match(code, /HttpResponse\.json\(\{ "id": 7, "qty": 2 \}, \{ status: 201, headers: \{ "x-request-id": "r-1" \} \}\)/);
    assert.match(code, /MSW matches the path only/);
    assert.doesNotMatch(code, /content-length|redacted"/);
  });

  it('fails like the network for a failed call, and sends bytes for a binary body', () => {
    assert.match(formatMswHandler({ method: 'GET', url: 'https://api.test/down', state: 'error', error: 'ECONNREFUSED' }), /HttpResponse\.error\(\)/);
    const bin = formatMswHandler({ method: 'GET', url: 'https://api.test/x.png', state: 'done', status: 200, resBody: 'AQL/', resBodyEncoding: 'base64' });
    assert.match(bin, /new HttpResponse\(Uint8Array\.from\(atob\("AQL\/"\)/);
  });
});

describe('nock', () => {
  it('matches method, path, JSON body and query, and replies like the capture', () => {
    const code = formatNock(created);
    assert.match(code, /nock\("https:\/\/api\.test"\)/);
    assert.match(code, /\.post\("\/v1\/orders", \{ "qty": 2 \}\)/);
    assert.match(code, /\.query\(\{ "tenant": "a", "tag": \[ "x", "y" \] \}\)/);
    assert.match(code, /\.reply\(201, \{ "id": 7, "qty": 2 \}, \{ "content-type": "application\/json", "x-request-id": "r-1" \}\);/);
  });

  it('replies with the error of a failed call', () => {
    assert.match(formatNock({ method: 'GET', url: 'https://api.test/down', state: 'error', error: 'ECONNREFUSED' }), /\.replyWithError\("ECONNREFUSED"\);/);
  });
});
