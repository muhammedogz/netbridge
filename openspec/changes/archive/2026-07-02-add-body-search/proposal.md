# Proposal: add-body-search

## Why

The filter box only matches `method`, `url`, `status`, and `source` — but "which request mentioned `order_id 123`?" is a body question, and answering it today means clicking through rows one by one. All body/header data is already on the client (roadmap: v0.2 near-term, `notes/ideas.md`).

## What Changes

- The existing filter input additionally matches request/response **headers** and **utf8 bodies** (base64 binary bodies are excluded — matching inside base64 text produces noise, not signal).
- Filtering stays responsive on large sessions: filter evaluation runs against a deferred value (`useDeferredValue`) so keystrokes never block on scanning up to 4000 × 256KB bodies.
- Placeholder text updated so the new scope is discoverable.
- No collector/capture/protocol changes; no new dependencies.

## Capabilities

### New Capabilities
- `request-filtering`: what the UI filter matches (terms, fields, body/header scope, exclusions) and its responsiveness guarantee.

### Modified Capabilities

<!-- none: openspec/specs/ has no existing filtering spec -->

## Impact

- `ui-src/src/App.tsx`: haystack construction + `useDeferredValue`.
- No changes under `src/`; smoke test unaffected.
