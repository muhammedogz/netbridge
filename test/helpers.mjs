/**
 * Shared harness for the netbridge integration tests: a local origin server,
 * a CLI runner that reports the collector's real port, and polling helpers.
 * Everything binds to 127.0.0.1 and picks free ports, so test files can run
 * in parallel and no network is needed.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const CLI = path.join(ROOT, 'dist', 'cli.js');
export const FIXTURES = path.join(__dirname, 'fixtures');

// Fail fast with a clear message when the package wasn't built: the CLI and
// the web UI are required dist/ + ui/ artifacts.
if (!fs.existsSync(CLI) || !fs.existsSync(path.join(ROOT, 'ui', 'index.html'))) {
  console.error('netbridge tests: missing build artifacts, run `pnpm build` first.');
  process.exit(1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value; throws after `timeoutMs`. */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* retry until the deadline */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/**
 * Local origin the fixtures talk to. Routes:
 *   /json   JSON body          /gzip  gzip-encoded JSON
 *   /echo   echoes the body    /boom  drops the socket (network error)
 *   /slow   headers now, body trickles over ~1s
 *   /big?kb=N  N KiB of text
 */
export async function startOrigin() {
  const server = http.createServer((req, res) => {
    const route = (req.url || '').split('?')[0];
    if (route === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ route: 'json', ok: true }));
    } else if (route === '/gzip') {
      const payload = zlib.gzipSync(JSON.stringify({ route: 'gzip', compressed: true }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(payload);
    } else if (route === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString('utf8') }));
      });
    } else if (route === '/boom') {
      req.socket.destroy();
    } else if (route === '/big') {
      const kb = Number(new URL(req.url, 'http://x').searchParams.get('kb')) || 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('b'.repeat(kb * 1024));
    } else if (route === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      let i = 0;
      const t = setInterval(() => {
        res.write('x');
        if (++i === 10) {
          clearInterval(t);
          res.end();
        }
      }, 100);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Run the netbridge CLI. Resolves once the collector printed its UI url.
 * `command` is the argv after `--`; `args` are netbridge options.
 */
export async function runCli({ args = [], command, env = {}, waitForUrl = true, cli = CLI } = {}) {
  const argv = [cli, '--port', '0', ...args];
  if (command) argv.push('--', ...command);
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, NETBRIDGE_QUIET: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  const handle = {
    child,
    exited,
    get output() {
      return output;
    },
    port: null,
    base: null,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    },
    async requests() {
      const res = await fetch(`${handle.base}/api/requests`);
      return res.json();
    },
    /** Poll /api/requests until `predicate(list)` holds. */
    async waitForRequests(predicate, label = 'captured requests') {
      return waitFor(
        async () => {
          const list = await handle.requests();
          return predicate(list) ? list : null;
        },
        { label, timeoutMs: 15_000, intervalMs: 150 }
      );
    },
  };

  if (waitForUrl) {
    const port = await waitFor(() => output.match(/http:\/\/localhost:(\d+)/)?.[1], {
      label: `netbridge UI url (output so far: ${JSON.stringify(output)})`,
    }).catch(async (err) => {
      await handle.stop();
      throw new Error(`${err.message}\n--- cli output ---\n${output}`);
    });
    handle.port = Number(port);
    handle.base = `http://127.0.0.1:${handle.port}`;
  }
  return handle;
}

/** Settled = no longer pending. */
export const settled = (r) => r.state === 'done' || r.state === 'error';
