/**
 * `netbridge mcp`: a Model Context Protocol server on stdio, so a coding
 * agent (Claude Code, Cursor, …) can read and replay captured traffic and
 * manage mock rules itself. It talks to a running collector over its HTTP
 * API and finds it the way the DevTools panel does: ports 4499–4510.
 *
 *   claude mcp add netbridge -- npx -y netbridge mcp
 */
import * as readline from 'readline';
import { callSteps, claimTime, duplicateCounts, startedAt } from './protocol';
import type { Entry, EntrySummary, Health, MockRule } from './protocol';
import { packageVersion } from './version';

const PORTS = Array.from({ length: 12 }, (_, i) => 4499 + i);
// Versions this server can speak (it only offers tools, which none of them
// changed); the client's choice wins when listed, else the first one.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];
const DEFAULT_BODY_CHARS = 20_000;

type Args = Record<string, unknown>;

class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Collector access
// ---------------------------------------------------------------------------

async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    const body = (await res.json()) as Health;
    return body?.app === 'netbridge' ? body : null;
  } catch {
    return null;
  }
}

/** The collector to use, plus a note when the choice was ambiguous. */
async function collector(args: Args): Promise<{ base: string; note: string }> {
  if (args.port != null) {
    const port = Number(args.port);
    if (!(await health(port))) throw new ToolError(`no netbridge collector answers on port ${port}`);
    return { base: `http://127.0.0.1:${port}`, note: '' };
  }
  // NETBRIDGE_PORT in the MCP server's env pins the collector.
  const pinned = Number(process.env.NETBRIDGE_PORT);
  if (pinned && (await health(pinned))) return { base: `http://127.0.0.1:${pinned}`, note: '' };
  const found = (await Promise.all(PORTS.map(async (p) => ((await health(p)) ? p : null)))).filter(
    (p): p is number => p !== null
  );
  if (found.length === 0) {
    throw new ToolError(
      'no running netbridge collector found on ports 4499-4510. Start the app through netbridge first, e.g. `npx netbridge -- next dev`.'
    );
  }
  const note =
    found.length > 1 ? `(collectors on ports ${found.join(', ')}; using ${found[0]}, pass "port" to pick another)\n` : '';
  return { base: `http://127.0.0.1:${found[0]}`, note };
}

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const error = (body as { error?: string })?.error ?? text;
    throw new ToolError(`${res.status} from netbridge: ${error}`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Formatting: compact text reads better for an agent than raw JSON.
// ---------------------------------------------------------------------------

function statusText(e: Pick<Entry, 'state' | 'status' | 'error'>): string {
  if (e.state === 'pending') return 'pending';
  if (e.state === 'error') return `error (${e.error ?? 'failed'})`;
  return String(e.status ?? '');
}

function line(e: EntrySummary, extra = ''): string {
  const tags = [
    e.source,
    e.gql ? `graphql:${e.gql.join(',')}` : '',
    e.gqlErrors ? `GRAPHQL-ERRORS:${e.gqlErrors.length}` : '',
    e.mocked ? `mocked:${e.mocked}` : '',
    e.parentId ? `parent:${e.parentId}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const ms = e.durationMs != null ? `${e.durationMs}ms` : '';
  return `${e.id}  ${e.method} ${e.url}  ${statusText(e)}  ${ms}  [${tags}]${extra}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars; raise maxBodyChars)` : text;
}

function bodyText(body: string | undefined, encoding: string | undefined, truncated: boolean | undefined, max: number) {
  if (body == null) return '(none)';
  let text = body;
  if (encoding === 'base64') text = `(binary, base64)\n${body}`;
  else {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return clip(text, max) + (truncated ? '\n(truncated at capture: the body was larger than NETBRIDGE_BODY_LIMIT)' : '');
}

function headerLines(h?: Record<string, string>): string {
  const lines = Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`);
  return lines.length ? lines.join('\n') : '(none)';
}

/** Waiting for the headers vs the body, and how a body in pieces arrived. */
function timing(e: Entry): string {
  if (e.ttfbMs == null) return '';
  const body = e.durationMs != null ? `, body ${e.durationMs - e.ttfbMs} ms` : ', body still arriving';
  const chunks = e.resChunks;
  const pieces = chunks?.length
    ? `; body came in ${chunks.length} pieces, first after ${chunks[0][0]} ms, last after ${chunks[chunks.length - 1][0]} ms`
    : '';
  return `timing: waiting for headers ${e.ttfbMs} ms${body}${pieces}`;
}

const TOKEN_CLAIMS = ['iss', 'sub', 'aud', 'azp', 'client_id', 'scope', 'scp', 'htm', 'htu'];

/** The JWTs in the request headers, decoded, with their validity at the call. */
function tokenLines(e: Entry): string[] {
  const at = startedAt(e);
  return (e.reqTokens ?? []).map((t) => {
    const claims = TOKEN_CLAIMS.filter((k) => t.claims[k] !== undefined).map(
      (k) => `${k}=${typeof t.claims[k] === 'string' ? t.claims[k] : JSON.stringify(t.claims[k])}`
    );
    const exp = claimTime(t.claims, 'exp');
    if (exp != null) {
      const mins = Math.round((exp - at) / 60000);
      claims.push(`exp=${new Date(exp).toISOString()} (${exp <= at ? `EXPIRED ${-mins} min before the call` : `valid ${mins} min more`})`);
    }
    return `token in ${t.header}${t.scheme ? ` (${t.scheme})` : ''}, alg ${t.jose.alg}: ${claims.join(', ')}`;
  });
}

function describe(e: Entry, max: number): string {
  const head = [
    `${e.method} ${e.url}`,
    `status: ${statusText(e)}${e.statusText ? ` ${e.statusText}` : ''}${e.durationMs != null ? `, ${e.durationMs} ms` : ''}`,
    `source: ${e.source}, pid ${e.pid}, id ${e.id}`,
    e.parentId ? `made while handling inbound request ${e.parentId} (see get_call_tree)` : '',
    e.mocked ? `answered by mock rule ${e.mocked}` : '',
    e.replayOf ? `replay of ${e.replayOf}` : '',
    timing(e),
    ...tokenLines(e),
  ].filter(Boolean);
  return [
    head.join('\n'),
    `## request headers (auth and cookie values are redacted)\n${headerLines(e.reqHeaders)}`,
    `## request body\n${bodyText(e.reqBody, e.reqBodyEncoding, e.reqBodyTruncated, max)}`,
    `## response headers\n${headerLines(e.resHeaders)}`,
    `## response body\n${bodyText(e.resBody, e.resBodyEncoding, e.resBodyTruncated, max)}`,
  ].join('\n\n');
}

function callTree(parent: EntrySummary | undefined, calls: EntrySummary[]): string {
  const dups = duplicateCounts(calls);
  const origin = parent ? startedAt(parent) : Math.min(...calls.map(startedAt));
  const rows = [...calls]
    .sort((a, b) => startedAt(a) - startedAt(b))
    .map((c) => {
      const n = dups.get(c.key);
      return `  +${startedAt(c) - origin}ms  ${line(c, n ? `  DUPLICATE x${n}` : '')}`;
    });
  const dupCalls = [...dups.values()].reduce((a, b) => a + b, 0);
  const summary = [
    `${calls.length} outbound call${calls.length === 1 ? '' : 's'}`,
    calls.length > 1 ? `${callSteps(calls)} sequential step(s)` : '',
    dups.size ? `${dupCalls} calls repeat ${dups.size} distinct request(s)` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const title = parent ? line(parent) : '(inbound request not recorded)';
  return `${title}\n${summary}\n${rows.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const PORT_PROP = {
  port: { type: 'number', description: 'collector port; omit to find the running one (4499-4510)' },
};

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run(args: Args): Promise<string>;
}

const STATUS_HELP = '"200", "4xx", "5xx", "error" or "pending"';

function matchesStatus(e: EntrySummary, wanted: string): boolean {
  const w = wanted.toLowerCase();
  if (w === 'error' || w === 'pending') return e.state === w;
  if (e.status == null) return false;
  const code = String(e.status);
  return w.length === 3 && [...w].every((ch, i) => ch === 'x' || ch === code[i]);
}

const tools: Tool[] = [
  {
    name: 'list_requests',
    description:
      'List captured server-side HTTP requests, newest last: id, method, url, status, duration, source and the inbound request that made it. Use get_request for headers and bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'only urls containing this text' },
        method: { type: 'string' },
        status: { type: 'string', description: STATUS_HELP },
        source: { type: 'string', enum: ['fetch', 'http', 'undici', 'replay', 'inbound'] },
        parent: { type: 'string', description: 'only calls made while handling this inbound request id' },
        limit: { type: 'number', description: 'newest N matches (default 50)' },
        ...PORT_PROP,
      },
    },
    async run(args) {
      const { base, note } = await collector(args);
      const q = new URLSearchParams({ summary: '1' });
      if (args.parent) q.set('parent', String(args.parent));
      if (args.source) q.set('source', String(args.source));
      let list = await api<EntrySummary[]>(base, `/api/requests?${q}`);
      if (args.url) list = list.filter((e) => e.url.toLowerCase().includes(String(args.url).toLowerCase()));
      if (args.method) list = list.filter((e) => e.method === String(args.method).toUpperCase());
      if (args.status) list = list.filter((e) => matchesStatus(e, String(args.status)));
      const total = list.length;
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 50;
      list = list.slice(-limit);
      if (total === 0) return `${note}no matching requests`;
      const head = total > list.length ? `showing the newest ${list.length} of ${total}\n` : '';
      return note + head + list.map((e) => line(e)).join('\n');
    },
  },
  {
    name: 'get_request',
    description: 'Full detail of one captured request: headers and decoded request/response bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        maxBodyChars: { type: 'number', description: `per body (default ${DEFAULT_BODY_CHARS})` },
        ...PORT_PROP,
      },
      required: ['id'],
    },
    async run(args) {
      const { base, note } = await collector(args);
      const entry = await api<Entry>(base, `/api/requests/${encodeURIComponent(String(args.id))}`);
      const max = Number(args.maxBodyChars) > 0 ? Number(args.maxBodyChars) : DEFAULT_BODY_CHARS;
      return note + describe(entry, max);
    },
  },
  {
    name: 'get_call_tree',
    description:
      'The outbound calls one inbound request (a page render, an API route) made, as a timeline: start offset, duration, status, duplicated calls and how many sequential steps they took. Omit id for the latest inbound request.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'inbound request id' }, ...PORT_PROP },
    },
    async run(args) {
      const { base, note } = await collector(args);
      let id = args.id ? String(args.id) : '';
      const inbound = await api<EntrySummary[]>(base, '/api/requests?summary=1&source=inbound');
      if (!id) {
        if (inbound.length === 0) return `${note}no inbound requests recorded yet (only requests that made outbound calls are)`;
        id = inbound[inbound.length - 1].id;
      }
      const calls = await api<EntrySummary[]>(base, `/api/requests?summary=1&parent=${encodeURIComponent(id)}`);
      const parent = inbound.find((e) => e.id === id);
      if (!parent && calls.length === 0) throw new ToolError(`no inbound request ${id}`);
      return note + callTree(parent, calls);
    },
  },
  {
    name: 'resend_request',
    description:
      'Re-issue a captured request from the collector, optionally with a different method, url, headers or body, and return the result. Redacted header values are dropped; pass real values in headers to include them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: ['string', 'null'], description: 'null sends no body' },
        ...PORT_PROP,
      },
      required: ['id'],
    },
    async run(args) {
      const { base, note } = await collector(args);
      const { port: _port, ...payload } = args;
      const entry = await api<Entry>(base, '/api/resend', json(payload));
      return note + describe(entry, DEFAULT_BODY_CHARS);
    },
  },
  {
    name: 'clear_requests',
    description: 'Empty the capture buffer, for a clean view of what happens next.',
    inputSchema: { type: 'object', properties: { ...PORT_PROP } },
    async run(args) {
      const { base, note } = await collector(args);
      await api(base, '/api/clear', { method: 'POST' });
      return `${note}cleared`;
    },
  },
  {
    name: 'list_mocks',
    description: 'The mock rules that answer, delay or fail matching outbound calls of the app.',
    inputSchema: { type: 'object', properties: { ...PORT_PROP } },
    async run(args) {
      const { base, note } = await collector(args);
      const rules = await api<MockRule[]>(base, '/api/mocks');
      return note + (rules.length ? JSON.stringify(rules, null, 2) : 'no mock rules');
    },
  },
  {
    name: 'set_mock',
    description:
      'Add a mock rule, or replace the rule with the same id. Matching calls from the app (fetch, axios, got, …) get the canned response, a delay, or a network failure, with no change to the app. Takes effect immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'set to replace an existing rule' },
        method: { type: 'string', description: 'empty for any method' },
        url: { type: 'string', description: 'url substring, or a pattern with * wildcards' },
        enabled: { type: 'boolean' },
        delayMs: { type: 'number', description: 'wait before answering (or before sending, without a response)' },
        fail: { type: 'string', description: 'fail like a refused connection, with this message' },
        response: {
          type: 'object',
          properties: {
            status: { type: 'number' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { description: 'a string, or any JSON value (sent as application/json)' },
          },
        },
        ...PORT_PROP,
      },
      required: ['url'],
    },
    async run(args) {
      const { base, note } = await collector(args);
      const { port: _port, ...rule } = args;
      const saved = await api<MockRule>(base, '/api/mocks', json(rule));
      return `${note}saved\n${JSON.stringify(saved, null, 2)}`;
    },
  },
  {
    name: 'delete_mock',
    description: 'Remove a mock rule by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...PORT_PROP }, required: ['id'] },
    async run(args) {
      const { base, note } = await collector(args);
      await api(base, `/api/mocks/${encodeURIComponent(String(args.id))}`, { method: 'DELETE' });
      return `${note}deleted ${args.id}`;
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio, one message per line.
// ---------------------------------------------------------------------------

function write(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function handle(msg: { id?: number | string; method?: string; params?: any }): Promise<void> {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  try {
    switch (method) {
      case 'initialize': {
        const wanted = params?.protocolVersion;
        write({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'netbridge', version: packageVersion() },
            instructions:
              'netbridge captures the outbound HTTP calls of a server-side app started through it (`npx netbridge -- <dev command>`), with full bodies. Use list_requests to see traffic, get_request for bodies, get_call_tree for what one page render or API route called, resend_request to replay, and set_mock to stub a backend.',
          },
        });
        return;
      }
      case 'ping':
        write({ id, result: {} });
        return;
      case 'tools/list':
        write({ id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
        return;
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) {
          write({ id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
          return;
        }
        try {
          const text = await tool.run((params?.arguments ?? {}) as Args);
          write({ id, result: { content: [{ type: 'text', text }] } });
        } catch (err) {
          const message = err instanceof ToolError ? err.message : `netbridge request failed: ${(err as Error).message}`;
          write({ id, result: { content: [{ type: 'text', text: message }], isError: true } });
        }
        return;
      }
      default:
        write({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (err) {
    write({ id, error: { code: -32603, message: (err as Error).message } });
  }
}

const inFlight = new Set<Promise<void>>();

export function runMcp(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (text) => {
    if (!text.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      write({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (msg && typeof msg === 'object') {
      const done = handle(msg as { id?: number; method?: string });
      inFlight.add(done);
      void done.finally(() => inFlight.delete(done));
    }
  });
  // stdin closing (the client is done, or input was piped) ends the server,
  // once the calls still running have written their replies.
  rl.on('close', () => {
    void Promise.allSettled([...inFlight]).then(() => process.exit(0));
  });
}
