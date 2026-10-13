---
name: netbridge
description: netbridge captures the outbound HTTP a Node.js / Next.js server makes (fetch, axios, got, ky, undici, http) with full decoded bodies, headers, status and timing, grouped under the page render or API route that made each call. Use when you need to see what a server-side app actually sent or received, debug a backend call (4xx/5xx, wrong payload, missing auth), find request waterfalls or repeated calls per page, mock or slow down a backend without code changes, or wire netbridge into an agent over MCP.
---

# netbridge

Browser DevTools shows browser → server traffic. netbridge shows the other half: what the server process itself sends **out**, with request and response bodies, and which inbound request (page render, API route, server action) each call belongs to. No code changes: it preloads into the Node process through `NODE_OPTIONS`.

## 1. Run the app through it

```bash
npx netbridge -- pnpm dev          # or: next dev, node server.js, tsx script.ts, …
```

- Everything after `--` runs as usual. Every Node process it starts (Next.js workers, `pnpm` → `tsx` → `node` chains) inherits the preload; non-Node children (curl, python) are invisible.
- The banner prints the UI address: `netbridge vX.Y.Z  UI  →  http://localhost:4499`. 4499 is the default; a busy port moves to the next free one, so **read the port from the banner** (or probe `GET /api/health` on 4499–4510: the collector answers `{"app":"netbridge", …, "ports":[<app ports>]}`).
- The collector lives exactly as long as the wrapped command. Start a dev server in the background (your shell's background mode, or `nohup … &`) and keep it running while you work; for a one-shot script, hold the collector open after the script exits:
  ```bash
  npx netbridge -- sh -c 'node script.mjs; sleep 600'
  ```
- Useful flags: `--port N`, `--mocks FILE` (load/save mock rules), `--overlay` (in-page bubble showing each page's server calls), `--exclude PATTERN` (hide noise in the UI only). Full list: `npx netbridge --help`.
- Environment knobs: `NETBRIDGE_REDACT=0` shows `authorization` / `cookie` / `set-cookie` / `x-api-key` values (redacted by default); `NETBRIDGE_BODY_LIMIT` raises the 256 KB per-body cap.

Done when `GET http://127.0.0.1:<port>/api/health` answers and the app is up.

## 2. Reproduce, then read the capture

Isolate the action you care about: clear, trigger it, read.

```bash
B=http://127.0.0.1:4499
curl -s -X POST $B/api/clear
# …load the page / call the route / run the flow…
curl -s "$B/api/requests?summary=1" | jq '.[] | {id, source, method, url, status, state, durationMs, parentId}'
curl -s $B/api/requests/<id> | jq        # one entry with headers and bodies
```

Reading entries:

- `state` is `pending`, `done` or `error`. An `error` entry carries `error` (the network failure, with its cause such as `ECONNREFUSED`); a `done` entry carries `status`.
- `source`: `fetch`, `http` (the `http`/`https` modules: axios, got, node-fetch…), `undici`, `replay` (a resend), or `inbound` (a request **your server received**).
- `parentId` links a call to the `inbound` entry it was made for. `GET /api/requests?parent=<inbound id>` lists one page render's calls. An inbound request appears only once it made an outbound call.
- Bodies are decoded (gzip/br/deflate). Binary bodies are base64 (`reqBodyEncoding` / `resBodyEncoding: "base64"`); bodies over the cap set `reqBodyTruncated` / `resBodyTruncated`. Redacted header values read `«redacted»`.
- `mocked` names the mock rule that answered the call instead of the backend.
- `ttfbMs` is the wait until the response headers came in; `durationMs` runs until the body was done. A long `ttfbMs` points at the server, a long gap after it at a big or streamed body.
- `reqTokens` holds the JWTs from the request headers, decoded at capture: `{ header, scheme, jose, claims }`, never the signature. Check `exp` against the entry's start (`ts - durationMs`), `aud`, `azp` and `scope` first when a call gets a 401 or 403; this works even though the header value itself reads `«redacted»`.
- `resChunks` lists when a body that came in pieces arrived, as `[ms since start, bytes]`. A `pending` entry that already has a `status` is still receiving its body: a stream such as an LLM response.

Query options for `/api/requests`: `parent=`, `source=`, `since=<epoch ms>`, `limit=<newest n>`, `summary=1` (no headers or bodies; use it first, then fetch single entries).

Done when you can point at the exact entry (or its absence) that explains the behaviour.

## 3. Act on it

Each of these is in [reference.md](reference.md):

- **Mock a backend**: canned response, network failure, or added latency for matching calls, live in a running app, no code change.
- **Resend** a captured request as-is or edited (method, url, headers, body).
- **Waterfalls and repeated calls**: what one page render called, in what order, and which calls ran more than once.
- **MCP server**: `npx netbridge mcp` gives an agent the same abilities as tools.

## When a call seems missing

Check these before suspecting netbridge:

- The app was started outside netbridge, or this is a different netbridge run (check `/api/health`'s `ports` against the app's port).
- A cache answered it: Next.js `fetch` cache / ISR hits never reach the network, so fewer calls than the code makes usually means the cache works.
- It ran in the Edge runtime (Next.js Edge middleware / route handlers): that isn't Node.
- It came from a non-Node child process.
- It's browser traffic: that's the browser's own Network tab.

netbridge binds to `127.0.0.1` and keeps captures in memory only. It is a development tool: run it around dev servers, scripts and tests, never around a production process.
