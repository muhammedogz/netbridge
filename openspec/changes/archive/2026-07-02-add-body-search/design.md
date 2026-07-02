# Design: add-body-search

## Context

`App.tsx` filters with a `useMemo` over `requests`, lower-casing a small per-row haystack (`method url status source`) and requiring every whitespace-split term to match. Sessions are capped at 4000 rows (`useRequests` `MAX_ROWS`), bodies at 256KB each (`NETBRIDGE_BODY_LIMIT`), so the worst-case scan is ~2GB of string — rare, but it must not freeze typing.

## Goals / Non-Goals

**Goals:**
- Terms match anywhere in url/method/status/source, header names/values, and utf8 request/response bodies.
- Typing stays responsive regardless of session size.

**Non-Goals:**
- Regex or field-scoped query syntax (`body:foo`) — plain substring terms only, consistent with today.
- Decoding/searching base64 (binary) bodies.
- Search-hit highlighting inside the detail pane.

## Decisions

1. **Extend the existing haystack, no toggle.** A "search bodies" checkbox was considered and rejected: an extra control for behavior users simply expect from a filter box; exclusion of binary bodies removes the noise argument.
2. **`useDeferredValue(filterText)` for the match computation.** React 19 is already in use; this keeps the input controlled and immediate while the expensive filter lags a frame or two under load. Alternatives: manual debounce (adds timers/state for a worse UX), web worker (overkill; data copies would cost more than the scan).
3. **Build the haystack lazily per row inside the filter pass** (string concat of small fields + `includes` directly on body strings, lower-cased via `toLowerCase` on the term side where possible). Per-row memoization (WeakMap) was rejected: `useRequests.applyEvent` mutates existing row objects in place, so object identity does not key their content and stale cache entries would return wrong matches.
4. **Case handling**: terms are lower-cased once; row fields/bodies lower-cased per evaluation. Cost is the scan itself either way; correctness stays obvious.

## Risks / Trade-offs

- [Worst-case scan is still O(total body bytes) per evaluation] → deferred value keeps input responsive; the 4000-row / 256KB caps bound the absolute cost; if real sessions prove painful, per-row lowercase caching keyed by `(id, state, resBody length)` is a follow-up.
- [Matches in bodies are invisible in the row (only url/method/status shown)] → acceptable: the count + selecting the row's body tab answers "where"; highlighting is a listed non-goal.

## Open Questions

None.
