# Tasks: add-curl-har-export

## 1. cURL formatter

- [ ] 1.1 Add `shellQuote` helper and `formatRequestCurl(r: CapturedRequest): string` to `ui-src/src/lib.ts` (method/-X mapping, -H per header minus content-length, --data-raw for utf8 bodies, binary/truncated comments, `\` line continuations)
- [ ] 1.2 Add "cURL" item to `ITEMS` in `ui-src/src/components/CopyMenu.tsx`

## 2. HAR export

- [ ] 2.1 Add `buildHar(requests: CapturedRequest[], version: string): object` to `ui-src/src/lib.ts` per the har-export spec (entries sorted by seq, timings, base64 content encoding, _error/_state/_bodyTruncated custom fields)
- [ ] 2.2 Convert the header export button in `ui-src/src/App.tsx` into a split button: primary = existing raw JSON download, menu adds "HAR 1.2" (fetch `/api/requests` + `/api/health` version, `downloadBlob` as `.har`)

## 3. Verification

- [ ] 3.1 `pnpm build` (includes UI typecheck) and `pnpm test` pass
- [ ] 3.2 Manual check: copy a POST as cURL from the smoke-test session and re-run it; import an exported `.har` into Chrome DevTools
