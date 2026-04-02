# PLM Workbench Audit CSV SDK Parity Design

Date: 2026-03-28

## Problem

`/api/plm-workbench/audit-logs/export.csv` already existed in backend runtime, but the contract stopped halfway:

- source OpenAPI did not expose the CSV export route
- `packages/openapi/dist-sdk/client.ts` only exposed JSON audit list/summary helpers
- `apps/web/src/services/plm/plmWorkbenchClient.ts` kept a second handwritten fetch path for CSV text and filename parsing

That left `audit list/summary` on the SDK contract, while `audit export` still depended on a private frontend-only implementation.

## Design Goal

Make collaborative audit export follow the same single contract chain as the rest of `plm-workbench`:

`backend route -> source OpenAPI -> dist OpenAPI -> dist-sdk runtime -> apps/web client`

## Decisions

1. Add `/api/plm-workbench/audit-logs/export.csv` to `packages/openapi/src/paths/plm-workbench.yml`.
2. Add an SDK runtime helper `exportCollaborativeAuditLogsCsv(...)` to `createPlmWorkbenchClient(...)`.
3. Extend the SDK transport with an optional text response path instead of forcing CSV export through the JSON-only `request(...)` helper.
4. Keep filename parsing inside the SDK helper so the web client only consumes `{ filename, csvText }`.
5. Keep the web layer's existing query normalization (`buildPlmCollaborativeAuditSearch(...)`) and only delegate the final request to the SDK helper.

## Scope

Files changed by design:

- `packages/openapi/src/paths/plm-workbench.yml`
- `packages/openapi/dist-sdk/client.ts`
- `apps/web/src/services/plm/plmWorkbenchClient.ts`
- focused tests for SDK paths/runtime and web client export behavior

## Non-Goals

- Reworking the backend CSV export implementation
- Changing CSV column layout
- Replacing the existing CSV download UX in the frontend
