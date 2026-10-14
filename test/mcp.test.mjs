/**
 * `netbridge mcp`: JSON-RPC over stdio. Drives the real server against a
 * running collector: handshake, tool list, and each tool's output.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { CLI, FIXTURES, runCli, settled, startOrigin, waitFor } from './helpers.mjs';

function startMcp(env = {}) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  return {
    child,
    request(method, params) {
      const id = next++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve) => pending.set(id, resolve));
    },
    async tool(name, args = {}) {
      const msg = await this.request('tools/call', { name, arguments: args });
      return { text: msg.result.content[0].text, isError: msg.result.isError === true };
    },
    stop() {
      child.stdin.end();
      return new Promise((r) => child.on('exit', r));
    },
  };
}

let origin;
let nb;
let app;
let mcp;
// GET /mocked requests the app served: each is recorded with its two calls.
let mockedServed = 0;

before(async () => {
  origin = await startOrigin();
  nb = await runCli({ command: [process.execPath, path.join(FIXTURES, 'app.mjs')], env: { TARGET_ORIGIN: origin.url } });
  const health = await waitFor(
    async () => {
      const h = await (await fetch(`${nb.base}/api/health`)).json();
      return h.ports?.length ? h : null;
    },
    { label: 'app port' }
  );
  app = `http://127.0.0.1:${health.ports[0]}`;
  await fetch(`${app}/page`);
  await nb.waitForRequests((l) => l.filter((e) => e.parentId && e.state === 'done').length === 3, 'page calls');
  mcp = startMcp({ NETBRIDGE_PORT: String(nb.port) });
});

after(async () => {
  await mcp?.stop();
  await nb?.stop();
  await origin?.close();
});

describe('netbridge mcp', () => {
  it('completes the handshake', async () => {
    const msg = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(msg.result.protocolVersion, '2025-06-18');
    assert.equal(msg.result.serverInfo.name, 'netbridge');
    assert.ok(msg.result.capabilities.tools);
    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  });

  it('lists its tools', async () => {
    const msg = await mcp.request('tools/list', {});
    const names = msg.result.tools.map((t) => t.name);
    for (const name of ['list_requests', 'list_hosts', 'get_request', 'get_call_tree', 'resend_request', 'set_mock', 'list_mocks', 'delete_mock', 'clear_requests']) {
      assert.ok(names.includes(name), name);
    }
    for (const t of msg.result.tools) assert.equal(t.inputSchema.type, 'object');
  });

  it('lists requests with filters', async () => {
    const all = await mcp.tool('list_requests');
    assert.equal(all.isError, false);
    assert.match(all.text, /GET http:\/\/127\.0\.0\.1:\d+\/page {2}200/);
    const inbound = await mcp.tool('list_requests', { source: 'inbound' });
    assert.equal(inbound.text.trim().split('\n').length, 1);
    const none = await mcp.tool('list_requests', { status: '5xx' });
    assert.equal(none.text, 'no matching requests');
  });

  it('shows the call tree of the latest inbound request', async () => {
    const { text } = await mcp.tool('get_call_tree');
    assert.match(text, /3 outbound calls, 3 sequential step\(s\), 2 calls repeat 1 distinct request\(s\)/);
    assert.equal((text.match(/DUPLICATE x2/g) || []).length, 2);
  });

  it('sums up calls per host', async () => {
    const { text } = await mcp.tool('list_hosts');
    // /page made three calls to the origin; the inbound request itself isn't one.
    assert.match(text, /^127\.0\.0\.1:\d+ {2}3 calls {2}p50 \d+ms, p95 \d+ms, max \d+ms {2}\d+ B received$/m);
  });

  it('shows one request with headers and bodies', async () => {
    const list = await nb.requests();
    const call = list.find((e) => e.source === 'fetch');
    const { text } = await mcp.tool('get_request', { id: call.id });
    assert.match(text, /## response body\n\{\n {2}"route": "json"/);
    assert.match(text, /made while handling inbound request/);
    const missing = await mcp.tool('get_request', { id: 'nope' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /404/);
  });

  it('resends a request', async () => {
    const call = (await nb.requests()).find((e) => e.source === 'fetch');
    const { text } = await mcp.tool('resend_request', { id: call.id });
    assert.match(text, /source: replay/);
    assert.match(text, new RegExp(`replay of ${call.id}`));
  });

  it('manages mock rules', async () => {
    const saved = await mcp.tool('set_mock', { url: '/mock-me', response: { status: 418, body: { tea: true } } });
    assert.match(saved.text, /"id": "m1"/);
    const body = await waitFor(
      async () => {
        const b = JSON.parse(await (await fetch(`${app}/mocked`)).text());
        mockedServed++;
        return b.fetch.status === 418 ? b : null;
      },
      { label: 'mock applied' }
    );
    assert.equal(body.fetch.body, '{"tea":true}');
    assert.match((await mcp.tool('list_mocks')).text, /"status": 418/);
    assert.match((await mcp.tool('delete_mock', { id: 'm1' })).text, /deleted m1/);
    assert.equal((await mcp.tool('list_mocks')).text, 'no mock rules');
    const bad = await mcp.tool('set_mock', { url: '' });
    assert.equal(bad.isError, true);
  });

  it('clears the buffer', async () => {
    // Events still on their way would land after the clear: wait for every
    // /mocked request served above to arrive, and for everything to settle.
    await nb.waitForRequests(
      (l) => l.filter((e) => e.source === 'inbound' && e.url.endsWith('/mocked')).length === mockedServed && l.every(settled),
      'all requests recorded and settled'
    );
    assert.match((await mcp.tool('clear_requests')).text, /cleared/);
    assert.equal((await nb.requests()).length, 0);
  });

  it('reports a missing collector as a tool error', async () => {
    const { text, isError } = await mcp.tool('list_requests', { port: 1 });
    assert.equal(isError, true);
    assert.match(text, /no netbridge collector answers on port 1/);
  });

  it('answers unknown methods with a JSON-RPC error', async () => {
    const msg = await mcp.request('resources/list', {});
    assert.equal(msg.error.code, -32601);
  });
});
