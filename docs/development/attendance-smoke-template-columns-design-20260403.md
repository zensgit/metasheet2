# Attendance Smoke Template Columns Design

## Context

`GET /api/attendance/import/template` returns `payloadExample.columns` as a CSV header hint (`string[]`). The on-prem smoke script was spreading that example directly into preview/commit payloads, while the import API reserves request-side `columns` for structured import-column objects. That mismatch caused `POST /attendance/import/preview` to fail with `VALIDATION_ERROR`.

## Scope

- Keep the fix entirely in the smoke script
- Treat `payloadExample.columns` and `payloadExample.requiredFields` as documentation-only hints
- Prefer the template response's `defaultProfileId` over a hard-coded import profile id

## Decision

Add a small sanitizer that derives a request payload from the template example while dropping example-only fields that are not valid preview/commit request fields. This keeps the smoke script aligned with the current API contract without changing runtime import behavior.

