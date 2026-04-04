# Attendance Self-Service Workbench Follow-up Verification

## Scope

Verify the existing employee self-service workbench surfaces anomaly-driven follow-up guidance, request backlog details, and still preserves quick-action prefill behavior.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts --watch=false
```

## Expected results

- The status card highlights the current attention count and anomaly reminder text.
- The request-status card shows backlog counts and recent request timing metadata.
- The quick-action card keeps prefilling leave and missing-punch drafts without leaving overview.
- No approval-center files or backend routes are changed by this slice.
