# PLM Workbench Approval Optimistic-Locking Design

## Background

`/api/approvals/:id/approve` and `/api/approvals/:id/reject` already existed in the backend, but they did not enforce the OpenAPI contract that described optimistic locking.

## Problem

- `approve` ignored `body.version`
- `reject` ignored `body.version`
- stale writes returned generic state errors instead of `409 APPROVAL_VERSION_CONFLICT`
- success responses returned a flat `{ success, id, status, version }` shape instead of `{ ok, data: { id, status, version, prevVersion } }`
- `reject` required `reason`, while the current UI payload can send only `comment`

## Decision

- make both routes require a valid integer `body.version`
- compare the requested version against the locked row version before mutating
- return `409` with `APPROVAL_VERSION_CONFLICT` when the version is stale
- return the canonical success envelope:
  - `{ ok: true, data: { id, status, version, prevVersion } }`
- make `reject` accept `reason ?? comment` so current callers stay compatible

## Implementation

- `packages/core-backend/src/routes/approvals.ts`
  - add local helpers to normalize `version` and optional text fields
  - reject requests missing a valid `version`
  - compare `requestedVersion` to `instance.version` after `FOR UPDATE`
  - keep the existing status guard after the version check
  - return `{ ok: true, data: ... }` for approve/reject success
  - for reject, derive the persisted reason from `reason ?? comment`
- `packages/openapi/src/paths/approvals.yml`
  - add `comment`/`metadata` on approve
  - add `reason`/`comment`/`metadata` on reject
  - document the success envelope and explicit `409` conflict payload
- `packages/openapi/src/openapi.yml`
  - mirror the same request/response updates in the aggregated source spec

## Expected Result

- stale approval actions fail deterministically with `409`
- success payloads match the documented envelope
- existing reject callers that only send `comment` keep working
