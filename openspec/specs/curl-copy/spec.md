# curl-copy Specification

## Purpose
TBD - created by archiving change add-curl-har-export. Update Purpose after archive.
## Requirements
### Requirement: Copy as cURL menu entry

The request copy menu SHALL offer a "cURL" item that copies a `curl` command reproducing the captured request to the clipboard.

#### Scenario: Item available for a settled request

- **WHEN** a captured request is selected and the copy menu is opened
- **THEN** a "cURL" item is listed alongside the Markdown/JSON items, and activating it copies the generated command and shows the existing "copied!" feedback

### Requirement: Generated command is runnable and shell-safe

The generated command SHALL be valid POSIX shell: every argument single-quoted with embedded single quotes escaped via `'\''`, method mapped with `-X` (omitted for GET), one `-H 'name: value'` per captured request header excluding `content-length`, and multi-line output joined with trailing `\` continuations.

#### Scenario: POST with JSON body

- **WHEN** a captured POST has utf8 body `{"a":1}` and header `content-type: application/json`
- **THEN** the command contains `curl`, the quoted URL, `-X POST`, `-H 'content-type: application/json'`, and `--data-raw '{"a":1}'`, and contains no `content-length` header

#### Scenario: Values containing single quotes

- **WHEN** any header value, URL, or body contains a single quote (e.g. `it's`)
- **THEN** the copied command escapes it as `'\''` so the command parses in a POSIX shell

### Requirement: Non-replayable payloads are flagged, never silently mangled

Binary (base64-encoded) bodies SHALL NOT be inlined into the command; the command SHALL instead end with a `# binary body omitted (<size>) — use download` comment. Truncated bodies SHALL append a `# body truncated at capture` comment. Redacted header values SHALL be emitted verbatim (`«redacted»`).

#### Scenario: Binary request body

- **WHEN** the captured request body has encoding `base64`
- **THEN** the command contains no `--data-raw` and ends with a comment noting the binary body was omitted

#### Scenario: Truncated request body

- **WHEN** the captured request body has `reqBodyTruncated: true`
- **THEN** the copied command includes the truncation comment

