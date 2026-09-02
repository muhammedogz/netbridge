# agent-integration Specification

## Purpose
Make captured traffic directly usable by AI agents: a per-request "AI prompt" copy that briefs an agent on one request, and a header control that copies instructions pointing an agent at the live collector API.

## Requirements
### Requirement: Copy as AI prompt

The request copy menu SHALL offer an "AI prompt" item, visually separated from the data formats, that copies a self-contained prompt containing: a one-paragraph explanation of what the data is, the full captured request (method, url, status, timing, headers, bodies — the "everything" Markdown rendering), and a task section matched to the outcome. The task SHALL differ by outcome: network-level failures (`state: error`, including the captured error message) ask for root-cause analysis of connection/DNS/TLS/timeout causes; `5xx` asks to read the response for the failure detail while also checking the request; `4xx` asks to identify what the server objected to in the request and produce a corrected request; success asks for an explanation and review. The prompt SHALL note body truncation when present and that redacted header values are the inspector's doing, not the wire's.

#### Scenario: Prompt for a 404

- **WHEN** a captured request with status 404 is copied as an AI prompt
- **THEN** the copied text contains the full request/response data and a task section that treats the request as rejected and asks for the corrected request

#### Scenario: Prompt for a network failure

- **WHEN** a captured request with `state: "error"` and error `ECONNREFUSED` is copied as an AI prompt
- **THEN** the task section quotes the error and asks for network-level root-cause analysis and a fix

### Requirement: Agent API instructions button

The header SHALL provide an `api` button that copies instructions for reading the live collector API, built from the page origin: the `GET /api/requests`, `GET /api/health`, `GET /events` and `POST /api/clear` endpoints with one-line descriptions, a `curl` example, and notes on reading entries (truncation flags, base64 body encoding, redacted headers). The button SHALL show the standard "copied!" feedback.

#### Scenario: Copy agent instructions

- **WHEN** the `api` button is clicked on `http://localhost:4499`
- **THEN** the clipboard contains instructions listing all four endpoints as absolute `http://localhost:4499/...` URLs
