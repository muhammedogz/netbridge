# request-filtering Specification

## Purpose
Narrow the live request list to what the user is looking for, and hide what they don't want to see: a filter query (free text over metadata, headers and text bodies, keyed terms, `-` exclusions) that persists across reloads and can be seeded from the CLI, combined with structured chip filters for method, status class and source.
## Requirements
### Requirement: Structured filter chips

The UI SHALL provide toggleable filter chips for method (the common verbs GET/POST/PUT/PATCH/DELETE plus any other method actually captured), status class (`2xx`/`3xx`/`4xx`/`5xx`/`error`/`pending`) and source (`fetch`/`http`). Within one dimension selected chips are ORed; across dimensions and with the text filter, conditions are ANDed. A dimension with no chip selected matches everything. A reset control SHALL clear all active chips at once.

#### Scenario: Status class chip

- **WHEN** the `4xx` chip is active and the text filter is empty
- **THEN** only requests whose response status is 400–499 remain and the count reads `<matching>/<total>`

#### Scenario: Chips combine with text search

- **WHEN** the `POST` chip is active and the text filter is `order_id`
- **THEN** only POST requests that match `order_id` in a searched field remain

#### Scenario: Unusual method appears as a chip

- **WHEN** an `OPTIONS` request is captured
- **THEN** an `OPTIONS` chip appears alongside the common verbs

### Requirement: Filter matches metadata, headers, and text bodies

The filter input SHALL treat the entered text as whitespace-separated terms where every term must hold. A free-text term (one without a recognized key) matches when it is a case-insensitive substring of at least one of: method, url, status, source, request/response header names or values, or request/response bodies whose captured encoding is `utf8`. Bodies with encoding `base64` SHALL NOT be searched.

#### Scenario: Term found only in a response body

- **WHEN** exactly one captured request's utf8 response body contains `order_id`
- **THEN** filtering by `order_id` shows only that request and the count reads `1/<total>`

#### Scenario: Terms across different fields

- **WHEN** the filter is `POST order_id`
- **THEN** only requests that match `POST` (metadata) AND contain `order_id` in any searched field remain

#### Scenario: Binary bodies excluded

- **WHEN** a request's response body is captured base64-encoded and its raw base64 text happens to contain the term
- **THEN** that body does not cause a match

### Requirement: Exclusions and keyed terms

A leading `-` SHALL invert any term, hiding the rows it matches. A term of the form `key:value`, where the key is `url`, `host` (alias `domain`), `path`, `method`, `status` (alias `status-code`) or `source`, SHALL match only that attribute: `url`, `host` (including the port) and `path` (including the query string) by case-insensitive substring; `method` and `source` by case-insensitive equality; `status` by response code, where `x` matches any digit and a shorter value matches as a prefix, or by the row state `error` or `pending`. A term with any other key SHALL be treated as free text. Incomplete terms (a lone `-`, a key with no value) SHALL be ignored, and no input SHALL throw.

#### Scenario: Hide a telemetry collector

- **WHEN** the filter is `-host:localhost:4318`
- **THEN** requests to `http://localhost:4318/...` are hidden and every other request remains, including ones that mention `localhost:4318` in a body

#### Scenario: Free-text exclusion

- **WHEN** the filter is `-localhost:4318`
- **THEN** exactly the rows that the free-text term `localhost:4318` would show are hidden

#### Scenario: Keyed terms combine

- **WHEN** the filter is `-host:localhost:4318 method:post status:5xx`
- **THEN** only POST requests with a 5xx status to hosts other than `localhost:4318` remain

#### Scenario: Incomplete input

- **WHEN** the filter is `status:` or `-`
- **THEN** the term is ignored and no row is hidden by it

### Requirement: Hidden requests are accounted for

While a filter hides requests, the count SHALL expose how many are hidden (on hover), and when every captured request is hidden the list SHALL say so instead of looking empty.

#### Scenario: Everything filtered out

- **WHEN** 80 requests are captured and none matches the filter
- **THEN** the list reads that no requests match the filter and that 80 are hidden

### Requirement: Filter persists across reloads

The filter text SHALL be saved to `localStorage` on every change and restored on load. Storage failures SHALL be ignored.

#### Scenario: Reload keeps the filter

- **WHEN** the filter is `-host:localhost:4318` and the page is reloaded
- **THEN** the input still reads `-host:localhost:4318` and the same rows are hidden

### Requirement: CLI exclusions seed the filter

`netbridge --exclude <pattern>` (repeatable) SHALL make the UI start with one exclusion term per pattern in the filter: a pattern that parses as a keyed term is negated as given, any other pattern becomes `-url:<pattern>`. The collector SHALL expose the patterns and its start time at `GET /api/config`, and the UI SHALL read them before its first render and merge missing terms into the saved filter once per collector run. Exclusion is view-only: capture, export and the API are unaffected.

#### Scenario: Seeded from the command line

- **WHEN** netbridge starts with `--exclude localhost:4318` and the saved filter is `method:post`
- **THEN** the UI opens with the filter `-url:localhost:4318 method:post` and requests to that url never appear in the list

#### Scenario: User edits win within a run

- **WHEN** the user deletes the seeded term and reloads the page
- **THEN** the term stays deleted until netbridge is started again

### Requirement: Filtering never blocks typing

Filter evaluation SHALL run against a deferred copy of the input value so the input element updates on every keystroke even while a large session (thousands of rows with maximum-size bodies) is being scanned.

#### Scenario: Large session

- **WHEN** 4000 requests with large bodies are loaded and the user types quickly
- **THEN** each keystroke renders in the input immediately and the row list catches up afterwards

