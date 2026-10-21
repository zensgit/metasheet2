# Attendance Import Token Organization Binding - Development - 2026-09-12

## Problem

Staging QA run `34678668234` exercised product commit
`578e0d313aca4c5c7f66307e784feab17cdf62eb` with isolated synthetic
organizations. Import preview failed with HTTP 403 `COMMIT_TOKEN_INVALID`.
The prepare callers omitted their organization while preview and commit sent
an explicit organization. The backend resolved the prepare request to its
existing default organization and rejected use of that token in another one.

## Change

The live attendance view and the extracted import workflow pass the actual
import payload organization to prepare, including chunked requests and token
refresh retries. The API smoke and import performance scripts also send their
target organization on each prepare request.

OpenAPI documents the optional prepare request body and its optional `orgId`.
Generated specifications and SDK declarations follow the source. The backend's
existing missing-organization default and authorization rules are unchanged.

The regression specs execute explicitly in the required web script as well
as the attendance web guard. The ops contract checks the seven current prepare
call sites in the smoke and performance scripts.

## Scope and Compatibility

- No migration, role grant, organization membership, or feature flag change.
- No new user-facing controls or labels.
- Legacy callers that omit organization retain their existing behavior.
- Clients supplying an organization must use the same one for prepare and the
  subsequent preview or commit. This change updates the identified UI and ops
  callers; it does not validate every external client.
- Test data and runtime validation are limited to isolated synthetic fixtures.

## Delivery

Implementation base: `53ba819366f8e2b2a7dc2612ed18a8eefeb2ce53`.
Refs #4556 and #5669. Release checks and staging deployment must use the merged
commit's exact image identity. Image publication uses
`deploy_production=false`; staging uses `set_window_env=none` with rollout and
shadow flags OFF.

See [verification record](attendance-import-token-org-verification-20260912.md).
