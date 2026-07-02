# Tasks: add-body-search

## 1. Implementation

- [x] 1.1 In `ui-src/src/App.tsx`, defer the filter value with `useDeferredValue` and extend the match to headers + utf8 bodies per the request-filtering spec (matching extracted to pure `matchesFilter` in `ui-src/src/lib.ts`)
- [x] 1.2 Update the filter placeholder to `filter by url, method, status, body…`

## 2. Verification

- [x] 2.1 `pnpm build` (includes UI typecheck) and `pnpm test` pass
- [x] 2.2 Functional verification of `matchesFilter`: body-only term matches only the utf8-body row, case-insensitive, multi-term AND across fields, header name/value matches, base64 body text excluded, status still matches, blank query matches all
