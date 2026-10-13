# netbridge reference

The branches of step 3 in [SKILL.md](SKILL.md). Every endpoint is on the collector (`B=http://127.0.0.1:<port>`). Writes need `content-type: application/json`.

## Mock a backend

A mock rule answers the app's matching outbound calls itself. It goes live immediately, also in a dev server that is already running, with no change to the app. Use it to work without a backend, to force an error path, or to simulate a slow network.

```bash
# canned JSON answer
curl -s -X POST $B/api/mocks -H 'content-type: application/json' \
  -d '{"url": "/v1/users/me", "response": {"status": 200, "body": {"id": 1, "name": "Ada"}}}'
# refused connection for one method
curl -s -X POST $B/api/mocks -H 'content-type: application/json' \
  -d '{"method": "POST", "url": "/v1/orders", "fail": "orders service down"}'
# real backend, answer held back 1.5 s
curl -s -X POST $B/api/mocks -H 'content-type: application/json' \
  -d '{"url": "api.example.com", "delayMs": 1500}'

curl -s $B/api/mocks                       # list (each rule got an id: m1, m2, …)
curl -s -X DELETE $B/api/mocks/m1          # remove one
```

| Field | Meaning |
|---|---|
| `url` | required. A substring of the url, or a pattern where `*` matches anything and the pattern must cover the whole url (`https://api.test/users/*/orders`) |
| `method` | empty or missing for any method |
| `response` | `{ "status", "headers"?, "body"? }`. A JSON value as `body` is sent as JSON |
| `fail` | fail like a refused connection, with this message. Exclusive with `response` |
| `delayMs` | wait first (0–120000). Alone, it delays the real backend's answer |
| `enabled` | `false` keeps the rule but turns it off |
| `id` | send an existing id to replace that rule |

- The first enabled rule that matches wins.
- Mocked calls stay in the capture with `mocked: "<rule id>"`, so you see what the app actually received.
- Rules cover `fetch` and the `http`/`https` modules (axios, got, ky, node-fetch, …). Calls through undici's own API (`undici.request`, `Client`, `Pool`) are captured but not mocked.
- `PUT /api/mocks` with a JSON array replaces the whole list. `npx netbridge --mocks mocks.json -- …` loads rules from a file and saves every change back to it, so a mock set can live in the repo.
- Remove the rules you added when you're done: they keep answering until the collector stops.

Done when a fresh capture of the call shows `mocked` set and the app behaves as the rule dictates.

## Resend a request

```bash
curl -s -X POST $B/api/resend -H 'content-type: application/json' -d '{"id": "<id>"}'
curl -s -X POST $B/api/resend -H 'content-type: application/json' \
  -d '{"id": "<id>", "url": "https://api.test/v2/orders", "headers": {"authorization": "Bearer …"}, "body": "{\"qty\":2}"}'
```

The collector sends it and returns the settled entry (`source: "replay"`, `replayOf: <original id>`). `"body": null` sends no body.

- Header values redacted at capture are dropped from the replay. Pass real values in `headers`, or start the app with `NETBRIDGE_REDACT=0` so the capture keeps them.
- `host`, `content-length` and similar headers are recomputed.
- Redirects are not followed.
- Signed single-use proofs (DPoP, nonces) can't be regenerated, so servers usually reject a replay that carries one.

## Waterfalls and repeated calls

Each outbound call made while the server handled an inbound request carries that request's id in `parentId`. The correlation follows `await`s, timers and promise chains via `AsyncLocalStorage`, with no app setup.

```bash
curl -s "$B/api/requests?summary=1&source=inbound" | jq '.[] | {id, method, url, status, durationMs}'
curl -s "$B/api/requests?summary=1&parent=<inbound id>" | jq '.[] | {url, status, ts, durationMs, key}'
```

- An entry's `ts` is when it last changed: its end time once settled. It started at `ts - durationMs`.
- Calls whose start/end ranges don't overlap waited on each other. Many sequential steps in one page render is the classic Server Component waterfall; a candidate for `Promise.all` or a parallel fetch.
- Summaries carry `key` (method + url + a hash of the request body). Two calls with the same `key` under one parent are a repeated call, the usual sign of a missing `cache()` or dedupe. Different GraphQL queries to one endpoint have different keys.
- Work right after the response (Next's `after()`, a log flush) still counts toward the request. A call that starts more than 2 s after the response and the request's last call is left unparented.

The MCP tool `get_call_tree` computes all of this for you: the timeline, repeats and the number of sequential steps.

## MCP server

`npx netbridge mcp` is a stdio MCP server over a running collector. Register it once:

```bash
claude mcp add netbridge -- npx -y netbridge mcp
```

Other clients take the usual config block:

```json
{ "mcpServers": { "netbridge": { "command": "npx", "args": ["-y", "netbridge", "mcp"] } } }
```

| Tool | Does |
|---|---|
| `list_requests` | summaries, filtered by `url` (substring), `method`, `status` (`404`, `4xx`, `error`, `pending`), `source`, `parent`; newest `limit` (default 50) |
| `get_request` | one entry with headers and decoded bodies (`maxBodyChars` per body) |
| `get_call_tree` | one inbound request's calls as a timeline with repeats and sequential steps; the latest one without `id` |
| `resend_request` | as `POST /api/resend` |
| `clear_requests` | empty the buffer |
| `list_mocks` / `set_mock` / `delete_mock` | as `/api/mocks` |

It finds the collector on ports 4499–4510. With several netbridge runs at once, set `NETBRIDGE_PORT=<port>` in the MCP server's environment, or pass `port` to a tool.

## All endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/requests` | every entry as a JSON array. Query: `parent=`, `source=`, `since=<epoch ms>`, `limit=<newest n>`, `summary=1` |
| `GET /api/requests/<id>` | one entry |
| `GET /api/health` | `{ app: "netbridge", version, requests, ports }`; `ports` are the ones the app listens on |
| `GET /events` | SSE: a `snapshot` event, then live capture events |
| `POST /api/clear` | empties the buffer (204) |
| `POST /api/resend` | see above |
| `GET` / `POST` / `PUT /api/mocks`, `DELETE /api/mocks/<id>` | see above |
