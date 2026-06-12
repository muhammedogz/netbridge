# netbridge

**The network tab your server never had.**

Browser DevTools can't see server-side HTTP traffic. When your Next.js Server Component, Route Handler, or Express backend calls an API, that request is invisible — no network tab, no bodies, no timing. netbridge gives you one, with **zero code changes**:

```bash
npx netbridge -- next dev
```

```
  netbridge UI  →  http://localhost:4499
```

Open the URL: live request list, headers, **full request/response bodies** (decompressed, pretty-printed JSON), timing, per-process attribution. Works with every HTTP client:

| Client | Stack | Captured |
|---|---|---|
| native `fetch` | undici | ✅ with bodies |
| ky | fetch | ✅ with bodies |
| axios | http/https | ✅ with bodies |
| got / superagent / request | http/https | ✅ with bodies |

## Quick start

```bash
# one-off, no install
npx netbridge -- next dev

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

## Why not …?

| Alternative | The catch |
|---|---|
| **Browser DevTools** | Only sees browser-originated requests. Server-side traffic never touches the browser. |
| **Node `--experimental-network-inspection`** | The flag is banned in `NODE_OPTIONS`, so it can't reach framework worker processes (Next.js spawns its server as a child — captures **nothing**). Response bodies arrive as raw compressed bytes or empty. Chrome-only, clunky `chrome://inspect` flow. |
| **OpenTelemetry** | Spans carry metadata only — **never bodies**. Requires instrumentation setup plus a local trace backend. |
| **mitmproxy / Charles / Proxyman** | External install, CA certificate juggling, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and undici ignores `HTTP_PROXY` anyway. |
| **`console.log`** | You always forget one, and it's gone on the next request. |

netbridge: no proxy, no certificates, no TLS downgrade, no code changes, any browser.

## How it works

```
netbridge -- next dev
   │
   ├─ starts a local collector + web UI (127.0.0.1, your machine only)
   └─ spawns your command with NODE_OPTIONS="--require netbridge/preload"
        │
        └─ the preload runs in EVERY Node process your tool spawns
           (Next.js workers included — env vars propagate where CLI flags can't)
             ├─ wraps globalThis.fetch     → fetch, ky, …
             └─ wraps http/https.request   → axios, got, …
                 └─ streams events to the collector (fire-and-forget)
```

- Runs before your framework boots, so even framework-patched `fetch` (Next.js caching) flows through the capture layer.
- Compressed responses (gzip/brotli/deflate) are decompressed before display.
- The capture layer never throws into your app, never keeps your process alive, and no-ops entirely unless launched through the netbridge CLI.

## Security & privacy defaults

- Collector binds to `127.0.0.1` only.
- `authorization`, `cookie`, `set-cookie`, `x-api-key` header values are redacted by default (`NETBRIDGE_REDACT=0` to disable).
- Bodies are capped at 256 KB per request (`NETBRIDGE_BODY_LIMIT` to change).
- Captured data lives in memory only — nothing is written to disk, nothing leaves your machine.
- This is a **development tool**. Don't wire it into production processes.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `NETBRIDGE_BODY_LIMIT` | `262144` | max captured body bytes per request |
| `NETBRIDGE_REDACT` | `1` | redact sensitive header values |
| `NETBRIDGE_QUIET` | `0` | suppress the per-process capture banner |

CLI flags: `--port <n>` to pick the UI port (auto-increments if busy).

## DevTools extension (optional)

Prefer living inside DevTools? `extension/` ships a Chrome DevTools panel
(like React DevTools) that auto-discovers your running collector and shows the
netbridge UI next to the browser's Network tab — client and server traffic in
one window. See [extension/README.md](extension/README.md) for install steps.

## Endpoints (for scripts / agents)

- `GET /api/requests` — JSON dump of captured requests
- `POST /api/clear` — reset the buffer
- `GET /events` — SSE stream (snapshot + live events)

## Scope: wire truth, outbound only

netbridge shows **actual outbound network traffic** — bytes that left your server. Two consequences worth knowing:

- **Framework lifecycle isn't here.** OTel-style spans (page render, route resolution) are internal framework timings, not network — use tracing for those. netbridge stays focused on "what did my server send, and what came back".
- **Cache hits show nothing — correctly.** When Next.js serves a fetch from its cache (ISR / fetch cache), no request hits the wire, so nothing appears. If you see fewer requests than your code makes, your cache is working.

## Limitations (v1)

- Inbound requests (browser → your server) are not captured — browser DevTools already shows that side. (An `--inbound` flag is on the roadmap.)
- Edge runtime isn't Node — not captured (Next.js Edge middleware/functions).
- Raw `undici.request()` / `undici.Client` calls bypass the fetch wrapper (rare; most apps use fetch or http-based clients).
- `FormData` / stream request bodies are not captured (response side still is).
- Child processes that are **not** Node (curl, python) are invisible.

## Development

```bash
pnpm install
pnpm build      # tsc → dist/
pnpm test       # self-contained smoke test (no network needed)
```

## License

MIT © Muhammed Oguz
