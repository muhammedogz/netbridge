# Design: add-curl-har-export

## Context

The UI already has per-request copy infrastructure (`CopyMenu` with Markdown/JSON formatters in `ui-src/src/lib.ts`) and a session JSON export (`App.tsx` `onExport` → `GET /api/requests` → `downloadBlob`). Captured requests carry method, url, headers (possibly redacted), bodies with `utf8|base64` encoding + truncation flags, status, timing (`durationMs`), `ts`, `seq`, and error state. The package must stay zero-runtime-dependency (ADR-008); the UI is React/Vite, devDeps only.

## Goals / Non-Goals

**Goals:**
- Runnable `curl` output for any settled captured request; paste into a POSIX shell and it re-issues the request.
- Valid HAR 1.2 that imports into Chrome DevTools ("Import HAR") and Insomnia without warnings that block loading.
- Preserve existing export UX: plain click on `export` still downloads the raw JSON.

**Non-Goals:**
- Request replay from the collector (separate roadmap item).
- HAR *import*/viewing inside netbridge.
- cmd.exe/PowerShell-specific cURL quoting (POSIX single-quote escaping only; works in every sh-like shell including Git Bash).
- Timing waterfall fidelity in HAR (we only have total duration; no DNS/connect/TTFB split).

## Decisions

1. **Pure formatters in `ui-src/src/lib.ts`** (`formatRequestCurl(r)`, `buildHar(requests, version)`), UI wiring kept thin. Alternative — a collector endpoint `/api/export.har` — rejected: duplicates data mapping server-side, and the UI already holds/fetches the same data; client-side keeps `src/` untouched.
2. **cURL escaping**: single-quote every argument, escaping embedded quotes with the `'\''` idiom. Alternative (double quotes + backslash escaping) rejected: `$`, backticks and `!` expand in double quotes.
3. **cURL shape**: multi-line with trailing `\` continuations (DevTools parity, readable). `-X <METHOD>` for everything except GET. Headers emitted with `-H`; skip `content-length` (curl recomputes; a captured value would be wrong after edits). Redacted header values are emitted as-is (`«redacted»`) — visibly a placeholder the user must fill; silently dropping the header would produce a request that fails mysteriously.
4. **cURL bodies**: utf8 bodies via `--data-raw`. Base64 (binary) bodies are NOT inlined — emit a trailing `# binary body omitted (N bytes) — use the download button` shell comment instead. Truncated bodies get a `# body truncated at capture` comment so the user isn't silently replaying a partial payload.
5. **HAR mapping** (hand-written, ~60 lines):
   - `log`: `{ version: '1.2', creator: { name: 'netbridge', version } }` (version from `/api/health`, best-effort `0.0.0` fallback). `pages` omitted — optional per spec; entries carry no `pageref`.
   - `entry.startedDateTime` = ISO(`ts`), `time` = `durationMs ?? 0`, `timings` = `{ send: 0, wait: durationMs ?? 0, receive: 0 }` (sum must equal `time` per spec; we only know the total).
   - `request`: headers as `[{name, value}]`, `queryString` parsed via `URL`, `cookies: []` (redacted by default anyway), `headersSize: -1`, `bodySize` from captured body, `postData: { mimeType, text }` for utf8 bodies; binary request bodies use `text` = base64 + custom `_encoding: 'base64'` (custom `_fields` are HAR-legal; official `encoding` exists only on response content).
   - `response`: `content: { size, mimeType, text, encoding?: 'base64' }` (official base64 support), `redirectURL: ''`, `headersSize: -1`, `bodySize`. Errored/pending requests export as `status: 0, statusText: ''` with `_error`/`_state` custom fields — matches how browsers represent failed entries.
   - Entries sorted by `seq`; all requests exported (settled and pending) so the file mirrors the table.
6. **Export UI**: reuse the CopyMenu split-button pattern (primary = `JSON — raw`, caret menu adds `HAR 1.2`) rather than a second header button — keeps the header compact and the interaction consistent.
7. **Verification without a UI test runner**: formatters are pure; correctness is enforced by `pnpm typecheck:ui` + build, plus a manual HAR import check into Chrome DevTools. Adding vitest for two formatters is not justified yet (would be the repo's first UI test dep; revisit when replay lands).

## Risks / Trade-offs

- [Redacted headers make the cURL non-functional as-is] → placeholder value is visible and greppable; `NETBRIDGE_REDACT=0` documented for local flows where real values are wanted.
- [HAR viewers vary in strictness] → stick to spec-required fields, `-1` for unknown sizes, custom fields underscore-prefixed; manually verify DevTools import once.
- [Truncated bodies export incomplete payloads] → flagged via `# body truncated` comment (cURL) and `_bodyTruncated` custom field (HAR); capture limit is configurable via `NETBRIDGE_BODY_LIMIT`.
- [`URL` parse failures on odd captured urls] → wrap in try/catch, fall back to empty `queryString`.

## Open Questions

None — all decisions above are settled for this change.
