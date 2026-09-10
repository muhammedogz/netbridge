# Tasks: add-request-replay

## 1. Protocol & collector

- [x] 1.1 `src/capture/shared.ts`: `source` union gains `'replay'`; add optional `replayOf` to `NetbridgeEvent` (mirrored in `ui-src/src/types.ts`)
- [x] 1.2 `src/server.ts`: `executeResend(spec)` — strip `«redacted»`-valued and computed/hop-by-hop headers, `fetch` with `redirect: 'manual'` + 30s timeout, response body via `BodyCollector`/`encodeBody`, synthesize start/end/error events through `record()` with `source: 'replay'` and `replayOf`
- [x] 1.3 `src/server.ts`: `POST /api/resend` route — bounded `readJsonBody` (4 MB, factored from the /ingest pattern), 404 unknown id, 400 invalid method / non-http(s) url, 200 with the settled merged entry
- [x] 1.4 `tsconfig.json`: add `DOM.Iterable` + `DOM.AsyncIterable` libs (fetch `Headers` / `ReadableStream` iteration)

## 2. UI

- [x] 2.1 `ui-src/src/lib.ts`: `parseHeadersText` (inverse of `headersText`), `resendRequest` (POST /api/resend, throws server `{error}`), agent briefing lists `POST /api/resend`
- [x] 2.2 New `ui-src/src/components/ResendDialog.tsx`: modal editor (method datalist, url, headers/body textareas), warnings (redacted / truncated / binary read-only + clear / DPoP), Esc + backdrop close, pending/error states
- [x] 2.3 `ui-src/src/components/DetailPane.tsx`: `resend` + `edit & resend` buttons in the action row, `replay of <id>` badge linking the original, inline resend error, state reset on entry change
- [x] 2.4 `ui-src/src/App.tsx`: Esc guard covers `.resend-overlay`; `onSelectEntry` passed to DetailPane. `FilterBar.tsx`: `replay` source chip. `styles.css`: `.resend-overlay`/`.modal` styles appended

## 3. Docs & verification

- [x] 3.1 README: `/api/resend` endpoint row + Replay section; `notes/ideas.md` entry marked done
- [x] 3.2 `test/smoke.test.mjs`: resend as-is (200, `state: done`, `source: replay`, `replayOf`, echoed body, buffer +1), edited body override, redacted `authorization` dropped while `x-test` kept, dead-route override → `state: error`, unknown id → 404, `file://` / missing url → 400; fixture lifetime extended for the round-trips
- [x] 3.3 `pnpm build` (tsc + UI typecheck + vite) and `node test/smoke.test.mjs` pass; manual UI pass (resend as-is, edited resend, Esc behavior, replay chip, api briefing)
