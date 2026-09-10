# netbridge

[![CI](https://github.com/muhammedogz/netbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/muhammedogz/netbridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/netbridge)](https://www.npmjs.com/package/netbridge)

**The network tab your server never had.**

Browser DevTools can't see server-side HTTP traffic. When your Next.js Server Component, Route Handler, or Express backend calls an API, that request is invisible. No network tab, no bodies, no timing. netbridge gives you one, with zero code changes:

```bash
npx netbridge -- next dev
```

```
  netbridge UI  →  http://localhost:4499
```

Open the URL and you get a live request list with headers, full request and response bodies (decompressed, JSON pretty-printed), timing, and the pid of the process that sent each request. Native `fetch` and fetch-based clients like ky go through the fetch wrapper; axios, got, superagent and friends go through the http/https wrapper. Bodies are captured either way.

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

Works with any command that ends up running Node:

```bash
netbridge -- pnpm dev
netbridge -- node server.js
netbridge -- npm run start:dev      # NestJS, Express, anything
netbridge --port 5000 -- next dev   # custom UI port
```

## The UI

The request table shows method, url, status, timing, size, and which process made the call. It auto-scrolls with new traffic, but only while you're at the bottom.

To narrow it down, the search box matches url, method, status, headers, and request/response bodies; space-separated terms must all match. Below it, chips toggle methods, status classes (`2xx` `3xx` `4xx` `5xx` `error` `pending`), and source (`fetch`/`http`). Chips in the same group are ORed, everything else is ANDed. Clicking `4xx` and `5xx` leaves only the failures. The `time` min/max boxes narrow by duration: `500` or `500ms` and `1s` or `1.5s` all work, and an empty box leaves that side open, so min `100ms` + max `500ms` gives a range, max `1s` alone shows everything up to a second, and min `500ms` alone shows only the slow ones.

Clicking a row opens the detail pane: headers, pretty-printed bodies, copy and download per body. `Esc` closes it. If you're typing in the search box, the first `Esc` just leaves the box.

"copy request" copies the selected request as Markdown, JSON, cURL, a `fetch` call, Python `requests`, or an AI prompt (more on that below). "export" downloads the session as raw JSON or HAR 1.2, which loads in Chrome DevTools, Insomnia, and any HAR viewer.

Dark and light themes, no external assets, everything served from `127.0.0.1`.

## Why not …?

| Alternative | The catch |
|---|---|
| Browser DevTools | Only sees browser-originated requests. Server-side traffic never touches the browser. |
| Node `--experimental-network-inspection` | The flag is banned in `NODE_OPTIONS`, so it can't reach framework worker processes. Next.js spawns its server as a child, so it captures nothing. Response bodies arrive as raw compressed bytes or empty. Chrome-only, clunky `chrome://inspect` flow. |
| OpenTelemetry | Spans carry metadata, never bodies. Requires instrumentation setup plus a local trace backend. |
| mitmproxy / Charles / Proxyman | External install, CA certificate juggling, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and undici ignores `HTTP_PROXY` anyway. |
| `console.log` | You always forget one, and it's gone on the next request. |

netbridge: no proxy, no certificates, no TLS downgrade, no code changes, any browser.

## How it works

```
netbridge -- next dev
   │
   ├─ starts a local collector + web UI (127.0.0.1, your machine only)
   └─ spawns your command with NODE_OPTIONS="--require netbridge/preload"
        │
        └─ the preload runs in EVERY Node process your tool spawns
           (Next.js workers included; env vars propagate where CLI flags can't)
             ├─ wraps globalThis.fetch     → fetch, ky, …
             └─ wraps http/https.request   → axios, got, …
                 └─ streams events to the collector (fire-and-forget)
```

- The preload runs before your framework boots, so even framework-patched `fetch` (Next.js caching) flows through the capture layer.
- netbridge decompresses gzip, brotli and deflate responses before showing them.
- The capture layer never throws into your app, never keeps your process alive, and no-ops entirely unless launched through the netbridge CLI.

## Security & privacy defaults

- The collector binds to `127.0.0.1` only.
- netbridge redacts `authorization`, `cookie`, `set-cookie`, `x-api-key` header values by default (`NETBRIDGE_REDACT=0` to disable).
- Bodies are capped at 256 KB per request (`NETBRIDGE_BODY_LIMIT` to change).
- Captured data lives in memory only. Nothing is written to disk, nothing leaves your machine.
- This is a development tool. Don't wire it into production processes.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `NETBRIDGE_BODY_LIMIT` | `262144` | max captured body bytes per request |
| `NETBRIDGE_REDACT` | `1` | redact sensitive header values |
| `NETBRIDGE_QUIET` | `0` | suppress the per-process capture banner |

CLI flags: `--port <n>` to pick the UI port (auto-increments if busy).

## DevTools extension (optional)

Prefer living inside DevTools? `extension/` ships a Chrome DevTools panel, like React DevTools, that auto-discovers your running collector and shows the netbridge UI next to the browser's Network tab. Client and server traffic in one window. See [extension/README.md](extension/README.md) for install steps.

## For AI agents

Captured traffic is exactly the evidence a coding agent (Claude Code, Cursor) needs when it debugs your server, so netbridge hands it over in two ways.

The `api` button in the header copies a short briefing to paste into the agent's chat: the endpoint list below, a curl example, and how to read entries (truncation flags, base64 bodies, redacted headers). After that the agent can watch your traffic on its own.

Each request's copy menu also has "AI prompt". It copies the full captured request plus a task matched to how the call ended. A network failure asks for root-cause analysis of the connection error, a 5xx asks the agent to read the response for the failure detail, a 4xx asks what the server objected to and for a corrected request, and a success asks for an explanation and review.

The endpoints, all on `127.0.0.1`:

| Endpoint | Returns |
|---|---|
| `GET /api/requests` | every captured request as a JSON array: headers, full bodies, timing, errors |
| `GET /api/health` | `{ app: "netbridge", version, requests }`, lets scripts find a running collector |
| `GET /events` | SSE stream: a `snapshot` event, then live capture events |
| `POST /api/clear` | resets the capture buffer |
| `POST /api/resend` | re-issues a captured request; `{"id"}` resends as-is, add `method`/`url`/`headers`/`body` to resend with edits; returns the settled replay entry |

## Replay

Every captured request can be re-issued: the `resend` button re-sends it unchanged, and `edit & resend` opens an editor for method, URL, headers and body first. The replay is sent from the collector process, appears in the list as a new `replay` entry linked to the original, and agents can trigger the same thing via `POST /api/resend`.

Fidelity notes: header values the inspector redacted at capture (`«redacted»`) are stripped before sending — paste real values in the editor to include them. Computed headers (`host`, `content-length`, …) are dropped and recomputed. Redirects are not followed, so a 302 shows as a 302. Signed single-use proofs like DPoP cannot be regenerated (the signing key lives in your app), so such replays are typically rejected by the server — the editor warns when it sees one.

## Scope: wire truth, outbound only

netbridge shows actual outbound network traffic, the bytes that left your server. Two consequences worth knowing:

- Framework lifecycle isn't here. OTel-style spans (page render, route resolution) are internal framework timings, not network. Use tracing for those; netbridge stays focused on what your server sent and what came back.
- Cache hits show nothing, and that's correct. When Next.js serves a fetch from its cache (ISR or fetch cache), no request hits the wire, so nothing appears. If you see fewer requests than your code makes, your cache is working.

## Limitations (v1)

- Inbound requests (browser → your server) are not captured. Browser DevTools already shows that side; an `--inbound` flag is on the roadmap.
- Next.js Edge middleware and Edge functions run outside Node, so they're invisible.
- Raw `undici.request()` / `undici.Client` calls bypass the fetch wrapper. Rare; most apps use fetch or http-based clients.
- `FormData` and stream request bodies are not captured. The response side still is.
- Child processes that aren't Node (curl, python) are invisible.

## Development

```bash
pnpm install
pnpm build      # tsc → dist/
pnpm test       # self-contained smoke test (no network needed)
```

## License

MIT © Muhammed Oguz
