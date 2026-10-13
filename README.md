# netbridge

[![CI](https://github.com/muhammedogz/netbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/muhammedogz/netbridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/netbridge)](https://www.npmjs.com/package/netbridge)

**The network tab your server never had.**

Browser DevTools can't see server-side HTTP. When a Next.js Server Component, a Route Handler or an Express backend calls an API, you get no network tab, no bodies and no timing for that call. netbridge gives you one, without touching your code:

```bash
npx netbridge -- next dev
```

```
  netbridge v0.6.1  UI  →  http://localhost:4499
```

Open the URL. Every outbound call shows up live with its headers, full request and response bodies (decompressed, JSON pretty-printed), status, timing and the pid of the process that sent it. Each call sits under the page render or API route that made it, so you can see which page fired what. Native `fetch`, ky, axios, got, superagent and node-fetch are captured with their bodies, and so are calls through undici's own API (response bodies need undici 7 or later).

## Quick start

```bash
# one-off, no install
npx netbridge -- next dev

# or run it bare and pick from your package.json scripts
npx netbridge
#   netbridge — what should it run?
#     1) pnpm run dev  — next dev
#     2) pnpm run lint — eslint .
#   › command [1]:            ← Enter runs dev; type a number or any command

# or add a script to your project
npx netbridge init        # adds "dev:netbridge": "netbridge -- <your dev command>"
npm run dev:netbridge
```

Any command that ends up running Node works:

```bash
netbridge -- pnpm dev
netbridge -- node server.js
netbridge -- npm run start:dev      # NestJS, Express, anything
netbridge --port 5000 -- next dev   # custom UI port
netbridge --exclude localhost:4318 -- pnpm dev   # hide OpenTelemetry exports in the UI
netbridge --mocks api.mocks.json -- pnpm dev     # load and save mock rules
netbridge --overlay -- next dev     # a netbridge bubble on your app's pages
```

## The UI

The table shows method, url, status, timing, size and the process that made each call. It follows new traffic while you're scrolled to the bottom and stays put when you scroll up.

The filter box matches url, method, status, headers and bodies. Terms separated by spaces must all match. A leading `-` hides what a term matches, and keyed terms like `host:` look at one attribute (see [Filtering](#filtering)). Under the box, chips toggle methods, status classes (`2xx` `3xx` `4xx` `5xx` `error` `pending`) and sources (`fetch`, `http`, `undici`, `inbound`, `replay`). Chips in one group are ORed and everything else is ANDed, so clicking `4xx` and `5xx` leaves only the failures. The `time` boxes take `500`, `500ms`, `1s` or `1.5s`. Fill in min, max or both: max `1s` alone shows everything up to a second, min `500ms` alone shows only the slow calls.

Click a row for the detail pane with headers, pretty-printed bodies, and copy and download buttons per body. `Esc` closes it. If you're typing in the filter box, the first `Esc` only leaves the box.

"copy request" copies the selected request as Markdown, JSON, cURL, a `fetch` call, Python `requests` or an AI prompt (see [For AI agents](#for-ai-agents)). It also turns the call into a test double: an MSW handler or a nock scope that answers with the captured status, headers and body, ready to paste into a test. "export" downloads the session as raw JSON or as HAR 1.2, which opens in Chrome DevTools, Insomnia and other HAR viewers.

The header also holds **mocks** (see [Mocking backends](#mocking-backends)), **mcp / api** (see [For AI agents](#for-ai-agents)), a theme switch (light, dark, or follow the system) and a settings menu. The settings menu picks the list layout, grouped or flat, and remembers it in the browser.

The UI loads nothing from the internet and is served from `127.0.0.1`. It keeps only the rows in view in the DOM, so a buffer of thousands of requests scrolls as fast as a short one.

## Calls per request

netbridge ties each call to the request your server was handling when it made it: a page render, an API route, a server action. The list shows that inbound request as a header row with its calls indented below:

```
▾ 3 calls  dashboard   localhost:3000/        200   840 ms   inbound
     ×2    user        api.example.com/v1/    200   120 ms   fetch
     ×2    user        api.example.com/v1/    200   118 ms   fetch
           orders      api.example.com/v1/    200   300 ms   http
```

Click the inbound row to open its **Calls** tab. It draws what the request called as a waterfall on one time axis and counts two things:

- **Sequential steps** are runs of calls that overlap in time. Five calls in five steps waited on each other, which is the classic Server Component waterfall. Five calls in one step ran in parallel.
- **Repeated calls** (`×2`) are the same method, url and body more than once for one request. That usually means a missing `cache()` or dedupe. The body counts, so different GraphQL queries to one endpoint aren't flagged.

A call's detail pane links back to its request ("for GET /dashboard"), and the `▸` caret folds a request's calls away. If you'd rather have the old view, one row per outbound call in arrival order, pick **flat list** in the settings menu. The flat list leaves inbound requests out unless the `inbound` source chip is on.

There's nothing to set up. The preload follows each request handler through `await`s, timers and promise chains with `AsyncLocalStorage`, the same mechanism Next.js uses for `headers()` and `cookies()`. An inbound request is recorded only once it makes an outbound call, which keeps static files and HMR pings out of the list. Calls made outside any request (startup, cron jobs) show on their own.

Work right after the response, such as Next's `after()` or a log flush, still counts toward the request. A call that starts more than 2 s after the response and after the request's last call doesn't. Without that cutoff, an OpenTelemetry batch export would land under whichever request first started the exporter's timer.

## Timing and streams

Each call's time splits in two: waiting until the response headers came in (time to first byte), then the body. The waterfall draws the waiting part of each bar lighter, and the time column's tooltip gives both numbers. A slow call with a long wait means a slow server; a short wait and a long body means a big or streamed download.

A response whose body is still coming after 100 ms shows up early, with its status and headers, and finishes when the last byte is in. That's how an LLM call looks while it streams. The detail pane's **timing** strip draws one tick per piece of the body as it came off the wire. A `text/event-stream` body opens as a list of events, with the raw text one click away. For Anthropic and OpenAI streams it also puts the streamed text back together from the deltas, so you can read what the model said.

## Mocking backends

A mock rule answers the app's outbound calls in place of the backend, with a canned response, a delay or a network failure. Reach for it when the backend doesn't exist yet, is down, or you need to see its error path. The app doesn't change, and a rule applies to the next call, even in a dev server that's already running.

The quickest start is a captured request. Select it and press **mock**, and the editor opens with its url and its captured response, ready to edit. **mocks** in the header lists the rules, each with a switch to turn it off.

| Field | Meaning |
|---|---|
| `url` | a url substring, or a pattern where `*` matches anything (`https://api.test/users/*/orders`) |
| `method` | empty for any |
| `response` | `{ "status", "headers", "body" }` to answer with. A JSON value as `body` is sent as JSON |
| `fail` | fail like a refused connection, with this message |
| `delayMs` | wait first. Without `response` or `fail`, the call still goes to the real backend and only its answer is held back, which simulates a slow network |
| `enabled` | `false` keeps the rule but turns it off |

The first enabled rule that matches wins. Mocked calls stay in the list with a `mock` tag, so you see what the app actually got.

`--mocks <file>` loads rules from a JSON array and writes every change back, so a set of mocks can live in your repo:

```json
[
  { "url": "/v1/users/me", "response": { "status": 200, "body": { "id": 1, "name": "Ada" } } },
  { "method": "POST", "url": "/v1/orders", "fail": "orders service down" },
  { "url": "api.example.com", "delayMs": 1500 }
]
```

Mocks cover `fetch` and the `http`/`https` modules (axios, got, ky, node-fetch and the like). Calls through undici's own API are captured but not mocked.

## The bubble (`--overlay`)

`netbridge --overlay -- next dev` adds a small bubble to the bottom-right corner of your app's pages, much like the Next.js dev indicator. It shows how many server calls the page made and whether any failed or repeated. Click it to see the waterfall of each request since the page loaded (the page itself, then the API routes and server actions it called), with a link to open the full detail in netbridge.

It's opt-in because it changes your HTML. On a page load, netbridge asks your server for an uncompressed response and appends one `<script>` tag. The bubble is an iframe served by the collector, so captured data never enters your page's JavaScript. If React re-renders the whole document and drops the bubble, the bubble puts itself back.

Two things to know when it doesn't show up:

- It's added on full page loads. A tab left open from before netbridge started, or a client-side navigation, won't get it until you reload.
- netbridge skips pages that send a `Content-Security-Policy` header.

## Filtering

The filter box works like the Chrome DevTools network filter. Terms separated by spaces must all match, matching ignores case, and the filter survives a reload.

| Term | Shows requests that |
|---|---|
| `order_id` | contain it in the url, method, status, headers or a text body |
| `-order_id` | don't contain it. A leading `-` turns any term into an exclusion |
| `url:/api/` | contain it in the url |
| `host:localhost:4318` | go to that host (port included). `domain:` works too |
| `path:/v1/` | contain it in the path or query string |
| `method:post` | use that method |
| `status:404` `status:4xx` | got that status (`x` is any digit). `status:error` and `status:pending` match failed and in-flight requests |
| `source:http` | came from that source: `fetch`, `http`, `undici`, `inbound` (requests your server received) or `replay` |

A term with an unknown key is plain text, so `localhost:4318` needs no escaping. While a filter is active the counter next to the box reads `shown/total`. Hover it to see how many requests are hidden.

### Hiding noise, like OpenTelemetry exports

An app that exports OpenTelemetry to a local collector sends `POST /v1/traces`, `/v1/metrics` and `/v1/logs` to `localhost:4318` every few seconds, which buries the calls you're debugging. Hide them with:

```
-host:localhost:4318
```

`-localhost:4318` works too, but it also hides any request that merely mentions the address in a header or body.

To hide them from the first render, pass `--exclude`:

```bash
npx netbridge --exclude localhost:4318 -- pnpm dev
```

The UI then opens with `-url:localhost:4318` in the filter box. `--exclude` is repeatable and takes a url substring or any keyed term (`--exclude method:options`, `--exclude status:3xx`). It only changes the view. Excluded requests are still captured, exported and served by the API. Each netbridge start adds its exclusions to the saved filter once, and you can still edit or remove them in the box.

## Why not …?

| Alternative | The catch |
|---|---|
| Browser DevTools | Only sees requests the browser makes. Server-side traffic never touches the browser. |
| Node `--experimental-network-inspection` | Node refuses the flag in `NODE_OPTIONS`, so it can't reach worker processes. Next.js runs its server as a child process, which leaves the flag capturing nothing. Response bodies arrive as raw compressed bytes or empty, and you're stuck with Chrome and the `chrome://inspect` flow. |
| OpenTelemetry | Spans carry metadata, never bodies. You need instrumentation setup plus a local trace backend. |
| mitmproxy / Charles / Proxyman | An external install, a CA certificate to trust, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and undici ignores `HTTP_PROXY` anyway. |
| `console.log` | You always forget one, and it's gone on the next request. |

netbridge needs no proxy, no certificates, no TLS downgrade and no code changes, and it works in any browser.

## How it works

```
netbridge -- next dev
   │
   ├─ starts a local collector + web UI (127.0.0.1, your machine only)
   └─ spawns your command with NODE_OPTIONS="--require netbridge/preload"
        │
        └─ the preload runs in EVERY Node process your tool spawns
           (Next.js workers included; env vars propagate where CLI flags can't)
             ├─ wraps globalThis.fetch       → fetch, ky, …
             ├─ wraps http/https.request     → axios, got, …
             ├─ listens on undici's channels → undici.request, Pool, …
             ├─ tracks the app's own server  → which request made each call
             ├─ applies mock rules (kept in sync with the collector)
             └─ streams events to the collector (fire-and-forget)
```

- The preload runs before your framework boots, so even a framework-patched `fetch` (Next.js caching) goes through the capture layer.
- netbridge decompresses gzip, brotli and deflate responses before showing them.
- The capture layer never throws into your app and never keeps your process alive. Outside the netbridge CLI it does nothing at all.

## Security and privacy defaults

- The collector binds to `127.0.0.1` only.
- Web pages you have open can't reach it either. It answers only requests addressed to a loopback host name, which blocks DNS rebinding. It refuses writes from any origin but its own UI, and it accepts captures only from processes it launched, which carry a per-run token.
- netbridge redacts the values of `authorization`, `cookie`, `set-cookie` and `x-api-key` headers by default (`NETBRIDGE_REDACT=0` to turn that off).
- Bodies are capped at 256 KB per request (`NETBRIDGE_BODY_LIMIT` to change).
- Captures live in memory only, up to 4000 requests and 256 MB of bodies and headers (`NETBRIDGE_BUFFER_LIMIT`). The oldest go first. Nothing is written to disk and nothing leaves your machine.
- This is a development tool. Keep it out of production processes.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `NETBRIDGE_BODY_LIMIT` | `262144` | max captured body bytes per request |
| `NETBRIDGE_BUFFER_LIMIT` | `268435456` | total body and header size kept (collector and UI) before the oldest requests are dropped |
| `NETBRIDGE_REDACT` | `1` | redact sensitive header values |
| `NETBRIDGE_QUIET` | `0` | suppress the per-process capture banner |
| `NETBRIDGE_ALLOWED_HOSTS` | | extra host names the UI may be opened under, comma-separated, for remote dev proxies (Codespaces, Gitpod). Loopback names always work |

CLI flags:

- `--port <n>` picks the UI port. A busy port moves to the next free one.
- `--exclude <pattern>` opens the UI with matching requests hidden, and is repeatable (see [Filtering](#filtering)).
- `--mocks <file>` loads and saves mock rules (see [Mocking backends](#mocking-backends)).
- `--overlay` adds the in-page bubble (see [The bubble](#the-bubble---overlay)).
- `--version` prints the installed version. The UI header and the start banner show it too.

## DevTools extension (optional)

`extension/` ships a Chrome DevTools panel, like React DevTools, for people who'd rather stay inside DevTools. It finds your running collector and shows the netbridge UI next to the browser's Network tab, so client and server traffic sit in one window. With several apps running through netbridge, it shows the one serving the page you're inspecting. See [extension/README.md](extension/README.md) for install steps.

## For AI agents

A coding agent debugging your server usually guesses at what went over the wire. netbridge gives it the captured traffic instead, in four ways.

**The skill.** [skills/netbridge](skills/netbridge/SKILL.md) teaches an agent the workflow: run the app through netbridge, isolate an action, read the entries, mock a backend, spot waterfalls and repeated calls. Install it with the [skills CLI](https://github.com/vercel-labs/skills), or copy `skills/netbridge/` into your agent's skills folder (`~/.claude/skills/` for Claude Code):

```bash
npx skills add muhammedogz/netbridge --skill netbridge    # -g installs it for every project
```

**The MCP server.** `netbridge mcp` lets the agent call netbridge as tools:

```bash
claude mcp add netbridge -- npx -y netbridge mcp
```

| Tool | Does |
|---|---|
| `list_requests` | lists captures, filtered by url, method, status, source, or the inbound request that made the calls |
| `get_request` | one request with headers and decoded bodies |
| `get_call_tree` | one page render's calls with timing, repeats and sequential steps |
| `resend_request` | re-sends a capture, optionally edited |
| `clear_requests` | empties the buffer before the agent triggers something |
| `list_mocks`, `set_mock`, `delete_mock` | stub a backend while the agent works |

It finds the running collector on ports 4499 to 4510. With several running, set `NETBRIDGE_PORT` in its environment to pin one.

**The briefing.** The **mcp / api** button in the header, also under "connect an agent" in the settings menu, opens a dialog with the MCP commands to copy (Claude Code, plus a config block for Cursor, Claude Desktop and other clients). Its **copy briefing** button copies a short text for agents without MCP. It lists the endpoints below with a curl example and explains how to read entries (truncation flags, base64 bodies, redacted headers). Paste it into the chat and the agent can read your traffic on its own.

**The AI prompt.** Each request's copy menu has "AI prompt". It copies the full captured request plus a task that fits how the call ended. A network failure asks for the root cause of the connection error. A 5xx asks the agent to find the failure detail in the response. A 4xx asks what the server objected to and for a corrected request. A success asks for an explanation and a review.

The endpoints, all on `127.0.0.1`:

| Endpoint | Returns |
|---|---|
| `GET /api/requests` | every captured request as a JSON array, with headers, full bodies, timing and errors. Optional query: `parent=<id>` (the calls one inbound request made), `source=`, `since=<epoch ms>`, `limit=<newest n>`, `summary=1` (no headers or bodies) |
| `GET /api/requests/<id>` | one entry |
| `GET /api/health` | `{ app: "netbridge", version, requests, ports }`, so scripts can find a running collector. `ports` are the ones the app listens on |
| `GET /events` | SSE stream, a `snapshot` event followed by live capture events |
| `POST /api/clear` | empties the capture buffer |
| `POST /api/resend` | re-sends a captured request. `{"id"}` sends it as it was; add `method`, `url`, `headers` or `body` to edit it first. Needs `content-type: application/json`. Returns the finished replay entry |
| `GET /api/mocks` | the mock rules |
| `POST /api/mocks` | adds a rule, or replaces the one with the same `id`. `PUT` replaces the whole list. Needs `content-type: application/json` |
| `DELETE /api/mocks/<id>` | removes a rule |

## Replay

Any captured request can be sent again. `resend` sends it unchanged, and `edit & resend` lets you change the method, URL, headers and body first. The collector process sends the replay, which shows up in the list as a new `replay` entry linked to the original. Agents can do the same through `POST /api/resend`.

A replay can differ from the original in a few ways:

- Header values redacted at capture (`«redacted»`) are left out. Paste real values in the editor to send them.
- netbridge drops computed headers (`host`, `content-length`, …) and lets the client recompute them.
- Redirects aren't followed, so a 302 shows as a 302.
- A signed single-use proof such as DPoP can't be regenerated, because the signing key lives in your app. Servers usually reject such a replay, and the editor warns you when it sees one.

## Scope: what went over the wire

netbridge shows the requests that actually left your server. Two things follow from that:

- Framework internals aren't here. Page render and route resolution timings are spans inside the framework, not network calls. Use tracing for those.
- Cache hits show nothing, which is correct. When Next.js serves a fetch from its cache (ISR or the fetch cache), no request goes out, so nothing appears. If you see fewer requests than your code makes, your cache is working.

## Limitations

- Inbound requests (browser to your server) appear only as the parent of the calls they made. One that calls nothing doesn't show up. The browser's own DevTools already covers that side.
- Next.js Edge middleware and Edge functions don't run in Node, so netbridge can't see them.
- Calls through undici's own API (`undici.request()`, `Client`, `Pool`) get response bodies with undici 7 or later. Older versions report headers, status and timing only. Mock rules don't apply to them.
- A `FormData` request body shows with a multipart boundary of netbridge's own. fetch picks its own random boundary on the wire, so only the separator lines differ.
- Child processes that aren't Node (curl, python) are invisible.

## Development

```bash
pnpm install
pnpm build      # tsc → dist/, vite → ui/
pnpm test       # node:test suites against the built CLI (no network needed)
pnpm lint       # Biome
```

`node test/run.mjs <name>` runs only the matching suites (`node test/run.mjs clients`). The suites drive the real CLI against a local origin. They cover capture through fetch, http, undici and real clients (axios, got, ky, node-fetch), request correlation, mock rules, the overlay, the MCP server, replay, the collector's guards, buffer limits and the CLI itself. `NETBRIDGE_HEAVY_TESTS=1` adds a slow case that pushes the collector past V8's maximum string length.

## License

MIT © Muhammed Oguz
