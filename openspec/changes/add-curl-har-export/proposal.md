# Proposal: add-curl-har-export

## Why

Captured traffic is currently locked inside netbridge's own JSON shape. The two most common next steps in a debugging loop — "re-issue this exact request from my terminal" and "open this session in standard tooling (Chrome DevTools, Insomnia, Charles)" — both require hand-translation today. Every field needed for cURL and HAR 1.2 is already captured, so this is pure presentation work (roadmap: v0.2 near-term, `notes/ideas.md`).

## What Changes

- Per-request **copy as cURL**: new item in the existing CopyMenu that generates a runnable, properly shell-escaped `curl` command from method/url/headers/body.
- Session **HAR export**: the header `export` button becomes a split button (same pattern as CopyMenu) offering `JSON — raw` (existing behavior, stays the primary action) and `HAR 1.2` (new `.har` download that opens in DevTools/Insomnia).
- No capture-layer, collector, or protocol changes. No new dependencies (HAR mapping is hand-written; the spec is small).

## Capabilities

### New Capabilities
- `curl-copy`: generate a runnable cURL command from a captured request (escaping, method/header/body mapping, binary/truncated handling).
- `har-export`: export the captured session as a valid HAR 1.2 file that standard viewers accept.

### Modified Capabilities

<!-- none: openspec/specs/ is empty; existing JSON export behavior is unchanged -->

## Impact

- `ui-src/src/lib.ts` (or new sibling modules): `formatRequestCurl`, `buildHar` pure formatters.
- `ui-src/src/components/CopyMenu.tsx`: one new menu item.
- `ui-src/src/App.tsx`: export split-button + HAR download path (reuses `/api/requests` + `downloadBlob`).
- No changes under `src/` (collector/capture); smoke test unaffected; UI typecheck covers the new code.
