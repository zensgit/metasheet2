# PLM Workbench approval read-route contract design

## Problem

`/api/approvals/:id/approve` and `/api/approvals/:id/reject` already return structured approval error envelopes, but the read routes still exposed legacy top-level string errors:

- `GET /api/approvals/pending`
- `GET /api/approvals/:id`

That left the approval module with split runtime contracts: mutation flows returned `ok/error.code/message`, while list/detail flows still returned plain `{ error: '...' }`.

## Design

Unify the approval read routes onto the same structured contract:

- `pending` actor-resolution failures return `APPROVAL_USER_REQUIRED`
- `detail` missing records return `APPROVAL_NOT_FOUND`
- read-route fetch failures use dedicated structured codes
- database-unavailable cases reuse `APPROVALS_DATABASE_UNAVAILABLE`

At the same time, bring OpenAPI source parity back:

- add the missing `/api/approvals/pending` path
- align `GET /api/approvals/{id}` with the runtime `401/403/404/503` response surface

## Expected outcome

Approval list/detail/mutate routes all expose the same error shape, so frontend feedback and SDK/OpenAPI consumers no longer need a route-by-route fallback for the same approval domain.
