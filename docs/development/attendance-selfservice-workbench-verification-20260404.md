# Attendance Self-Service Workbench Verification

## Scope

Verify the employee self-service workbench now surfaces:

- anomaly-driven focus items
- request follow-up callouts and readable status explanations
- a recommended next-step action
- unchanged quick-action prefill behavior

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expected results

- The status card highlights the current attention count and renders focus items for anomalies, pending approvals, or record review.
- The request-status card shows backlog counts plus one highlighted follow-up and per-request status explanation copy.
- The quick-actions card shows a recommended next step before the generic action buttons.
- The quick-action buttons still prefill leave and missing-punch drafts without leaving overview.
- No approval-center files or backend routes are changed by this slice.
