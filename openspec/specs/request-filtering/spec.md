# request-filtering Specification

## Purpose
TBD - created by archiving change add-body-search. Update Purpose after archive.
## Requirements
### Requirement: Filter matches metadata, headers, and text bodies

The filter input SHALL treat the entered text as whitespace-separated terms where every term must match (case-insensitive substring) at least one of: method, url, status, source, request/response header names or values, or request/response bodies whose captured encoding is `utf8`. Bodies with encoding `base64` SHALL NOT be searched.

#### Scenario: Term found only in a response body

- **WHEN** exactly one captured request's utf8 response body contains `order_id`
- **THEN** filtering by `order_id` shows only that request and the count reads `1/<total>`

#### Scenario: Terms across different fields

- **WHEN** the filter is `POST order_id`
- **THEN** only requests that match `POST` (metadata) AND contain `order_id` in any searched field remain

#### Scenario: Binary bodies excluded

- **WHEN** a request's response body is captured base64-encoded and its raw base64 text happens to contain the term
- **THEN** that body does not cause a match

### Requirement: Filtering never blocks typing

Filter evaluation SHALL run against a deferred copy of the input value so the input element updates on every keystroke even while a large session (thousands of rows with maximum-size bodies) is being scanned.

#### Scenario: Large session

- **WHEN** 4000 requests with large bodies are loaded and the user types quickly
- **THEN** each keystroke renders in the input immediately and the row list catches up afterwards

