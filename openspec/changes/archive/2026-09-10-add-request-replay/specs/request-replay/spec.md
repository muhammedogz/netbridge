# request-replay

## ADDED Requirements

### Requirement: Resend endpoint

The collector SHALL expose `POST /api/resend` accepting JSON `{ id?, method?, url?, headers?, body?, bodyEncoding? }`. When `id` is present the stored entry SHALL serve as the base with provided fields overriding it; without `id`, `method` and `url` SHALL be required. The endpoint SHALL reject an unknown `id` with 404 and an invalid method or non-`http(s)` URL with 400, SHALL await the replay settling (bounded by a timeout), and SHALL respond 200 with the settled replay entry — for network failures too, since those are recorded entries.

#### Scenario: Resend as-is

- **WHEN** `POST /api/resend` receives `{"id": "<captured POST>"}`
- **THEN** the response is the new entry with `state: "done"`, `source: "replay"`, `replayOf` set to the original id, and the re-issued request carried the original body

#### Scenario: Edited resend

- **WHEN** the payload overrides `body` (or `method`/`url`/`headers`)
- **THEN** the override is what goes on the wire and is what the replay entry records

#### Scenario: Unknown id / invalid target

- **WHEN** the payload names an id not in the buffer, or a `file://` URL, or omits both `id` and `url`
- **THEN** the endpoint responds 404 (unknown id) or 400 (invalid method/url) with a JSON `{ "error": ... }` body and no request is sent

### Requirement: Replay entries are first-class captures

Replays SHALL be recorded through the collector's event funnel as new entries: a start event when the send begins and an end (or error) event when it settles, so they stream to the UI live, count toward the buffer, and carry `source: "replay"` plus `replayOf` linking the original. A network failure SHALL settle the entry as `state: "error"` with a non-empty error message. Response bodies SHALL respect the capture body limit (`resBodyTruncated` beyond it) and the utf8/base64 encoding heuristic.

#### Scenario: Replay of a dead host

- **WHEN** a resend targets an unreachable URL
- **THEN** a replay entry exists with `state: "error"`, a non-empty `error`, and `durationMs`

### Requirement: Wire fidelity rules

The resend SHALL drop request headers whose captured value is exactly `«redacted»` (their real values were never captured) and computed/hop-by-hop headers (`host`, `content-length`, `connection`, `transfer-encoding`, `expect`, `upgrade`, `keep-alive`, `proxy-connection`, `accept-encoding`), letting the client recompute them. Headers recorded on the replay entry SHALL be re-sanitized so a user-re-entered secret is redacted in the store while the real value goes on the wire. Redirects SHALL NOT be followed. Bodies SHALL be dropped for GET/HEAD; base64 bodies SHALL be resent as their exact decoded bytes.

#### Scenario: Redacted auth is not sent

- **WHEN** a captured request stored `authorization: «redacted»` is resent as-is
- **THEN** the outgoing request carries no `authorization` header, other captured headers are preserved, and the replay entry's recorded headers contain no `authorization`

#### Scenario: Re-entered secret stays redacted in the store

- **WHEN** the editor submits a real `authorization` value
- **THEN** the wire request carries the real value but the replay entry records it as `«redacted»` (default redaction on)

### Requirement: Resend UI

The detail pane SHALL offer a `resend` action that re-issues the entry unchanged and an `edit & resend` action opening a modal editor with the entry's method, URL, headers (one `Key: value` per line) and body pre-filled. On success the new replay entry SHALL be selected; on failure the error SHALL be shown without losing the editor state. Escape and a backdrop click SHALL close the modal without closing the detail pane. The editor SHALL warn when redacted header values will be dropped, when the body was truncated at capture, when a DPoP proof makes rejection likely (warn-only; the header is sent as-is), and SHALL make binary (base64) bodies read-only with a "clear body" escape hatch. Replay entries SHALL show a `replay of <id>` badge that selects the original, and `replay` SHALL be offered as a source filter chip.

#### Scenario: Edit and resend

- **WHEN** the user edits the URL in the modal and submits
- **THEN** a new `replay` entry for the edited URL appears in the list and becomes the selected entry, and the modal closes

#### Scenario: Escape with the editor open

- **WHEN** Escape is pressed while the modal is open
- **THEN** only the modal closes; the detail pane stays open on the same entry
