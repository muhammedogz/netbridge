# Tasks: add-body-search

## 1. Implementation

- [ ] 1.1 In `ui-src/src/App.tsx`, defer the filter value with `useDeferredValue` and extend the match to headers + utf8 bodies per the request-filtering spec
- [ ] 1.2 Update the filter placeholder to `filter by url, method, status, body…`

## 2. Verification

- [ ] 2.1 `pnpm build` (includes UI typecheck) and `pnpm test` pass
- [ ] 2.2 Manual check against the smoke-test session: body-only term narrows the table; base64 bodies don't match
