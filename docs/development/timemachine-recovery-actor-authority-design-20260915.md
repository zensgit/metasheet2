# Time Machine Recovery Actor Authority

Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.
This is an existing recovery-permission hardening and canonical resolver reuse slice,
not a new grant, authentication mechanism, runtime enablement, or recovery semantic.

## Contract

The existing recovery resolver intersects request capabilities with transaction-fresh
database capabilities. A missing, inactive, or disabled database actor must have no
recovery authority, even when a stale request or surviving sheet assignment grants it.
Clearing global permissions alone is insufficient if a retained identity can reacquire
capabilities from sheet-level permissions.

1. Prove the old failure with a real database and the production recovery route: accept
   a preview while active, retain a sheet-specific grant, disable the actor, and require
   execute to refuse before any record change or preview-token burn.
2. Preserve request/database capability intersection, active sheet-grant positives,
   fresh grant behavior, row/field/link/person policy, and authority lease semantics.
3. Extract the existing database-side sheet resolver as a request-independent canonical
   function and consume it from the existing HTTP resolver. Background composition may
   reuse it later; it is not sufficient by itself for full-read or plan authorization.
4. Invalid actors return a denied access snapshot before sheet grant composition. No
   JWT fabrication, cached-admin bypass, or synthetic request enters production code.
5. Test missing/inactive/disabled actors, active explicit sheet grants, removed global
   grants, request-ceiling intersection, and same-token success after actor reactivation.

## Scope and Gates

Production file: `packages/core-backend/src/multitable/recovery-authorization-stability.ts`.
Tests: a focused resolver unit suite and the existing exact-anchor route real-DB suite.
No migration, workflow, flag, provider, or shared permission-service changes.

Use a disposable PostgreSQL database, fresh migration and replay, focused and neighboring
tests, mutation of the invalid-actor guard, typecheck, lint and an independent exact-code
review. Existing route-suite authentication is a synthetic test principal; the route,
authorization queries and recovery transaction are real. This is not login/browser/UAT.
Publish exact-code verification MD and a Draft/HOLD PR. No Ready, merge, deployment,
production, customer data, or whole-sheet hard-delete resurrection is authorized here.
