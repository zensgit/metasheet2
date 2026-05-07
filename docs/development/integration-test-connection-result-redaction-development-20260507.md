# Integration Test Connection Result Redaction - Development - 2026-05-07

## Context

`POST /api/integration/external-systems/:id/test` executes an adapter
`testConnection()` and returns the adapter result to the caller. Some adapters
or injected executors can include debug `raw`, `headers`, `config`, or
`credentials` payloads.

Returning that shape directly could expose connection strings, cookies, bearer
tokens, or executor internals to integration write users and persist secret text
through `lastError`.

## Change

- Added a small allowlist for public test-connection response keys:
  - `ok`
  - `status`
  - `code`
  - `message`
  - `authenticated`
  - `connected`
- Dropped untrusted adapter fields such as `raw`, `headers`, `config`, and
  `credentials` from the REST response.
- Added `redactSecretText()` for URL credentials, token query params,
  `Bearer`/`Basic` values, JWT-like strings, and long `SEC...` IDs.
- Sanitized thrown adapter messages and persisted `lastError` text.

## Behavioral Contract

- Connection test responses remain useful for status and operator-facing
  messages.
- Raw adapter debug payloads do not cross the REST boundary.
- Secret-bearing messages are redacted before response or persistence.
