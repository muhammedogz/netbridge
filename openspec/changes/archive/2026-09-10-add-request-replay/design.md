# Design: add-request-replay

## Where the replay runs

Capture only instruments the child app process; the collector is never patched. A replay issued by the collector is therefore invisible to capture and must synthesize its own `NetbridgeEvent`s through `record()` — the single store + SSE-broadcast funnel — which gives live UI updates for free. Sending from the collector is also the simple choice: there is no collector→child channel, and building one for replay would buy fidelity (the app's proxy/TLS context) at disproportionate cost.

## Decisions

- **One payload shape** `{ id?, method?, url?, headers?, body?, bodyEncoding? }`. With `id`, the stored entry is the base and provided fields override it (`id` becomes `replayOf`); without `id`, `method` + `url` are required. Serves resend-as-is, the editor, and agents synthesizing new requests.
- **The endpoint awaits completion and returns the settled merged entry.** Agents get the result inline instead of a 202+poll; the UI sees the row immediately anyway via the broadcast `start` event. A 30s `AbortSignal.timeout` bounds the wait; a network failure is still a recorded `state: "error"` entry, returned with HTTP 200.
- **Headers valued exactly `«redacted»` are stripped before sending.** Sending the literal is guaranteed garbage auth; a clean 401 is honest. The recorded replay entry re-runs the sent headers through `sanitizeHeaders()` so a user-re-entered token never sits unredacted in the buffer or SSE stream.
- **Dropped on send**: `host`, `content-length`, `connection`, `transfer-encoding`, `expect`, `upgrade`, `keep-alive`, `proxy-connection`, `accept-encoding` — fetch/undici recomputes these; a stale `content-length` after a body edit or a kept `accept-encoding` fighting auto-decompression would corrupt the send. Precedent: the cURL formatter already drops `content-length`.
- **`redirect: 'manual'`** — an inspector shows the true wire response; a 302 stays a 302.
- **URL validation**: `new URL()`, `http:`/`https:` only. The collector stays `127.0.0.1`-bound with no CORS, matching the existing threat model, but `/api/resend` is an arbitrary-request trigger so non-HTTP schemes are rejected outright.
- **Response body capture reuses the capture layer's conventions**: `BodyCollector` (same `NETBRIDGE_BODY_LIMIT` cap → `resBodyTruncated`) + `encodeBody` (utf8/base64 heuristic). fetch auto-decompresses, so no `decompressBody` pass.
- **Bodies**: `GET`/`HEAD` bodies are dropped (undici throws). Truncated bodies resend the captured bytes with a UI warning — the rest is unrecoverable by design. Base64 bodies are resent verbatim via `Buffer.from(body, 'base64')` with a read-only editor field and a "clear body" escape hatch.
- **DPoP is warn-only**: the proof is signed with the app's private key (never captured) and bound to method/URL/token with a single-use `jti`, so no fresh proof can be minted; the header is sent as-is (it is not in the redaction set) and the editor warns the replay will likely be rejected.
- **UI**: the modal lives inside `DetailPane` (local state); `App` only gains an Esc-guard (`.resend-overlay` joins `.copymenu-pop` in the Escape check) and passes `setSelectedId` down as `onSelectEntry`. Success feedback for resend-as-is is the selection jumping to the new replay entry — a button flash would be invisible across the re-render. Headers are edited as a `Key: value`-per-line textarea, the exact inverse of the existing `headersText()` formatter.
