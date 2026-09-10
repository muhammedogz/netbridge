# request-filtering Specification

## Purpose
Narrow the live request list to what the user is looking for: a free-text search over metadata, headers and text bodies, combined with structured chip filters for method, status class and source.
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

### Requirement: Duration range filter

The filter bar SHALL provide a minimum and a maximum duration input. Each accepts a number of milliseconds with an optional unit (`500`, `500ms`, `1s`, `1.5s`); an empty input leaves that side of the range open. A request matches when its duration is at least the minimum and at most the maximum (both inclusive). The duration filter is ANDed with the chips and the text filter. Requests without a duration (still pending) SHALL NOT match while any bound is set. An unparseable input, or a minimum greater than the maximum, SHALL be visibly flagged and ignored. The reset control SHALL also clear both inputs.

#### Scenario: Bounded range

- **WHEN** min is `100ms` and max is `500ms`
- **THEN** only requests that took 100–500 ms remain

#### Scenario: Open-ended bound

- **WHEN** only max is set to `1s`
- **THEN** only requests that took at most 1000 ms remain, and pending requests are hidden

#### Scenario: Invalid input

- **WHEN** min is `fast`
- **THEN** the min input is flagged and the list is not narrowed by it

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

