# Proposal: add-request-replay

## Why

The tightest backend debugging loop is "change one thing about that request and see what happens" — today that means copying as cURL, editing in a terminal, and losing the response outside the capture list. Every field needed to re-issue a captured request is already in the buffer, and the collector already owns the store + SSE funnel, so replays can appear in the UI like any capture (roadmap: v0.2 near-term, `notes/ideas.md`).

## What Changes

- New collector endpoint **`POST /api/resend`**: re-issues a captured request (`{"id"}` as-is) or an edited variant (`id` + `method`/`url`/`headers`/`body` overrides), synthesizes start/end/error events through `record()`, and returns the settled replay entry. New entries carry `source: "replay"` and `replayOf: <original id>`.
- UI: a **`resend`** button (as-is) and an **`edit & resend`** modal editor (method, URL, headers as `Key: value` lines, body) in the detail pane, with warnings for redacted headers, truncated/binary bodies and DPoP proofs. The new entry is auto-selected; a `replay of` badge links back to the original.
- Fidelity rules: headers valued `«redacted»` are stripped before sending; computed/hop-by-hop headers dropped; redirects not followed; `replay` joins the source filter chips.
- Agent briefing, README endpoint table and smoke test extended. No new dependencies.

## Capabilities

### New Capabilities
- `request-replay`: re-issue a captured (optionally edited) request from the collector and record the outcome as a first-class capture entry.

### Modified Capabilities
- `agent-integration`: the `api` button's briefing now lists five endpoints (adds `POST /api/resend`).

## Impact

- `src/capture/shared.ts`: `source` union gains `'replay'`; new `replayOf` field.
- `src/server.ts`: `POST /api/resend` route, `executeResend`, bounded `readJsonBody` helper.
- `ui-src/src/`: new `components/ResendDialog.tsx`; `DetailPane.tsx` buttons + badge; `lib.ts` (`parseHeadersText`, `resendRequest`, agent briefing); `App.tsx` Esc guard + selection callback; `FilterBar.tsx` chip; `types.ts`; `styles.css` modal styles.
- `tsconfig.json`: `lib` gains `DOM.Iterable`/`DOM.AsyncIterable` (fetch `Headers`/`ReadableStream` iteration in the collector).
- `test/smoke.test.mjs`: replay assertions (as-is, edited, redaction, error path, validation).
