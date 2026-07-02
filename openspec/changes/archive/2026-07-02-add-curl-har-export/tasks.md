# Tasks: add-curl-har-export

## 1. cURL formatter

- [x] 1.1 Add `shellQuote` helper and `formatRequestCurl(r: CapturedRequest): string` to `ui-src/src/lib.ts` (method/-X mapping, -H per header minus content-length, --data-raw for utf8 bodies, binary/truncated comments, `\` line continuations)
- [x] 1.2 Add "cURL" item to `ITEMS` in `ui-src/src/components/CopyMenu.tsx`

## 2. HAR export

- [x] 2.1 Add `buildHar(requests: CapturedRequest[], version: string): object` to `ui-src/src/lib.ts` per the har-export spec (entries sorted by seq, timings, base64 content encoding, _error/_state/_bodyTruncated custom fields)
- [x] 2.2 Convert the header export button in `ui-src/src/App.tsx` into a split button: primary = existing raw JSON download, menu adds "HAR 1.2" (new `ExportMenu` component, fetch `/api/requests` + `/api/health` version, `downloadBlob` as `.har`)

## 3. Verification

- [x] 3.1 `pnpm build` (includes UI typecheck) and `pnpm test` pass
- [x] 3.2 Functional verification (exceeded the planned manual check): generated cURL for a hostile POST (quotes/`$HOME`/backticks) executed through `sh` against a live origin with byte-identical method/header/body round-trip; `buildHar` output for done/error/binary/truncated/pending entries validates against the official `har-schema` (HAR 1.2) JSON schema; per-scenario unit checks for both formatters all pass
