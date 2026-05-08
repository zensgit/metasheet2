# K3 WISE Mock WebAPI Log Redaction Design

Date: 2026-05-07

## Context

The K3 WISE offline PoC fixture uses `mock-k3-webapi-server.mjs` to prove the
preflight -> adapter -> evidence chain before a customer GATE answer arrives.
The mock server records every request in `mock.calls` and can forward the same
event to a caller-provided debug `logger`.

Before this change, the recorded call body was the raw POST body. Login requests
can include `username`, `password`, `acctId`, tokens, and other credential-like
fields. Those records are test-only, but they are likely to be copied into
debug output, local evidence, or screenshots during a live PoC rehearsal.

## Change

The mock server now separates request handling from observability:

- Raw body is still used internally to decide mock responses.
- `mock.calls` stores a sanitized copy.
- The optional `logger` receives the same sanitized event.
- Sensitive keys are replaced with `<redacted>` recursively in objects and
  arrays.

The redaction key pattern covers common fixture credential names:

- `password`
- `secret`
- `token`
- `session`
- `credential`
- `apiKey` / `api_key` / `api-key`
- `authorization`
- `acctId`
- `accountId` / `account_id` / `account-id`

## Non-Goals

- This does not change the real K3 WISE adapter.
- This does not change the mock WebAPI response contract.
- This does not redact ordinary business fields such as `FNumber` and `FName`.

## Expected Behavior

`/K3API/Login` can still succeed with a real body, but `mock.calls` and logger
events no longer expose login credentials. Material/BOM save calls keep normal
business payload fields visible so existing PoC assertions can continue to
inspect Save-only behavior.
