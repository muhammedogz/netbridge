# har-export Specification

## Purpose
TBD - created by archiving change add-curl-har-export. Update Purpose after archive.
## Requirements
### Requirement: HAR 1.2 session export

The UI header SHALL offer an export menu whose primary action remains the existing raw JSON download and which additionally offers "HAR 1.2", downloading the full collector state (`GET /api/requests`) as `netbridge-export-<timestamp>.har`.

#### Scenario: Plain export click preserved

- **WHEN** the user clicks the export button directly
- **THEN** the raw JSON export downloads exactly as before this change

#### Scenario: HAR download

- **WHEN** the user picks "HAR 1.2" from the export menu
- **THEN** a `.har` file downloads containing `log.version === "1.2"`, `log.creator.name === "netbridge"`, and one entry per captured request ordered by `seq`

### Requirement: HAR entries map captured data faithfully

Each entry SHALL set `startedDateTime` from `ts` (ISO 8601), `time` and `timings.wait` from `durationMs` (0 when unknown, `send`/`receive` 0 so timings sum to `time`), request/response headers as `{name, value}` arrays, `queryString` parsed from the URL (empty on parse failure), `headersSize: -1`, utf8 request bodies as `postData.text` with `mimeType` from `content-type`, and response bodies as `content.text` with `content.encoding: "base64"` when the captured encoding is base64. Truncated bodies SHALL be marked with a `_bodyTruncated` custom field.

#### Scenario: Completed JSON request round-trips

- **WHEN** a captured request has status 200, utf8 request and response bodies, and `durationMs` 42
- **THEN** its entry has `response.status` 200, `time` 42, `timings` summing to 42, `postData.text` and `content.text` equal to the captured bodies, and `content.mimeType` from the response `content-type` header

#### Scenario: Binary response body

- **WHEN** a captured response body has encoding `base64`
- **THEN** the entry's `content.text` is the base64 string and `content.encoding` is `"base64"`

### Requirement: Unsettled and failed requests still export

Errored requests SHALL export with `response.status` 0 and an `_error` custom field carrying the captured error message; pending requests SHALL export with `response.status` 0 and `_state: "pending"`. The export SHALL never throw on partial data.

#### Scenario: Failed request

- **WHEN** a captured request has `state: "error"` and no response fields
- **THEN** its entry has `response.status` 0, `content.size` 0, and `_error` set to the captured message

