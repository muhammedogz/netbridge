# agent-integration

## MODIFIED Requirements

### Requirement: Agent API instructions button

The header SHALL provide an `api` button that copies instructions for reading the live collector API, built from the page origin: the `GET /api/requests`, `GET /api/health`, `GET /events`, `POST /api/clear` and `POST /api/resend` endpoints with one-line descriptions, a `curl` example, and notes on reading entries (truncation flags, base64 body encoding, redacted headers). The `/api/resend` description SHALL state the payload shape (`{"id"}` as-is; `method`/`url`/`headers`/`body` overrides), that the settled replay entry is returned, and that redacted header values are stripped before sending. The button SHALL show the standard "copied!" feedback.

#### Scenario: Copy agent instructions

- **WHEN** the `api` button is clicked on `http://localhost:4499`
- **THEN** the clipboard contains instructions listing all five endpoints as absolute `http://localhost:4499/...` URLs, including `POST /api/resend`
