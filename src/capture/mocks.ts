/**
 * Mock rules, app side. The collector owns the rules; every preloaded process
 * keeps a copy, fed by a long-lived stream from the collector, and matches
 * its calls against it synchronously.
 *
 * - fetch: a mocked call never leaves the process, the wrapper builds the
 *   Response itself.
 * - http/https: the call is pointed at the collector's /__mock endpoint,
 *   which answers with the rule's response. Clients see an ordinary
 *   IncomingMessage either way.
 */
import * as fs from 'fs';
import { findMock, normalizeMockRules } from '../protocol';
import type { MockRule } from '../protocol';
import { config, pristineHttpRequest } from './shared';

let rules: MockRule[] = [];
let synced = false;
let onSync: (() => void)[] = [];
/** How long a process's first calls wait for the rules at most. */
const SYNC_WAIT_MS = 300;
const syncDeadline = Date.now() + SYNC_WAIT_MS;

function setRules(next: unknown): void {
  if (Array.isArray(next)) rules = next as MockRule[];
  if (!synced) {
    synced = true;
    for (const resolve of onSync) resolve();
    onSync = [];
  }
}

export function mockFor(method: string, url: string): MockRule | undefined {
  return rules.length === 0 ? undefined : findMock(rules, method, url);
}

/**
 * Until the first sync: a promise that resolves once the rules arrived, or
 * shortly after when the collector doesn't answer. The fetch wrapper waits on
 * it so a process's first calls see the rules too. Its timer is a regular
 * (ref'd) one: the caller's fetch is pending, so the process must not exit.
 * After the first sync: undefined, so the wrapper doesn't wait at all.
 */
export function mocksReady(): Promise<void> | undefined {
  if (synced) return undefined;
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, syncDeadline - Date.now()));
    onSync.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

let retryMs = 500;

function connect(): void {
  let buffer = '';
  const req = pristineHttpRequest(
    {
      host: '127.0.0.1',
      port: config.port,
      path: '/api/mocks/stream',
      headers: { 'x-netbridge-token': config.token },
      agent: false,
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        setRules(undefined);
        return;
      }
      retryMs = 500;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          try {
            if (line.trim()) setRules(JSON.parse(line));
          } catch {
            /* skip a malformed line */
          }
          nl = buffer.indexOf('\n');
        }
      });
      res.on('end', reconnect);
    }
  );
  // Never keep the host process alive for the rules stream.
  req.on('socket', (socket) => socket.unref());
  req.on('error', () => {
    setRules(undefined);
    reconnect();
  });
  req.end();
}

let reconnecting = false;
function reconnect(): void {
  if (reconnecting) return;
  reconnecting = true;
  const t = setTimeout(() => {
    reconnecting = false;
    connect();
  }, retryMs);
  t.unref?.();
  retryMs = Math.min(retryMs * 2, 10_000);
}

export function startMockSync(): void {
  // `--mocks <file>`: rules known at launch apply from the first call, even
  // the synchronous http ones made before the stream connects.
  const file = process.env.NETBRIDGE_MOCKS_FILE;
  if (file) {
    try {
      const parsed = normalizeMockRules(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (Array.isArray(parsed)) rules = parsed;
    } catch {
      /* the collector reports a bad file; the stream still syncs */
    }
  }
  const t = setTimeout(() => setRules(undefined), SYNC_WAIT_MS);
  t.unref?.();
  connect();
}
