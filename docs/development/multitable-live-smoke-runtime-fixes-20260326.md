# Multitable Live Smoke Runtime Fixes 2026-03-26

## Context

`multitable-next` had already reached route/runtime/OpenAPI parity and embed-host protocol coverage, but the first real end-to-end `pilot-local` run against a fresh PostgreSQL database still exposed runtime gaps that were invisible to contract-only checks.

The failures were not concentrated in one layer. They crossed:

- multitable field-type runtime support
- database migration completeness on fresh databases
- request permission derivation for dev-token pilot runs
- comments API persistence preconditions
- smoke harness assumptions around import retry and manager reconcile timing
- workbench dialog metadata hydration while dependent overlays stay open
- embed-host applied-context reporting versus real route state
- busy/deferred replay after in-flight form submit

The goal of this slice is to convert those real-environment failures into deterministic runtime behavior and deterministic pilot evidence, without widening the scope into unrelated multitable UI WIP.

## Design

### 1. Add missing runtime support for `date` fields

The pilot smoke creates timeline/calendar fields with `type: "date"`. Runtime enums and OpenAPI had drifted away from that assumption.

The fix is to make `date` first-class again in:

- multitable runtime route validation
- backend integration coverage
- OpenAPI schemas and generated artifacts

This keeps the smoke flow aligned with the product contract instead of weakening the smoke to avoid date fields.

### 2. Promote missing schema prerequisites into formal migrations

Fresh pilot databases were missing:

- `meta_views.config`
- `meta_comments`

Those were previously masked by historical local databases or test-only bootstrap logic. The fix is to add formal forward migrations instead of relying on ad hoc local patches or test setup.

`meta_comments` is especially important because the embed/form/comment flow is now part of canonical pilot evidence. A runtime comments feature cannot remain test-only schema.

### 3. Align comments client parameters with the actual API contract

The frontend comments client was still sending:

- `containerId`
- `targetId`

while the backend contract actually requires:

- `spreadsheetId`
- `rowId`

The client now translates caller-facing multitable semantics into the backend route shape so workbench callers stay stable while the transport becomes correct.

### 4. Trust request-level role/permission claims in multitable context derivation

For pilot/dev-token runs, `jwtAuthMiddleware` and auth fallback were already deriving request user identity and permissions, but the multitable context route only looked at `req.user.roles` / `req.user.perms`.

The route now also trusts:

- `req.user.role`
- `req.user.permissions`

This keeps multitable capability derivation consistent with the rest of the backend and prevents false-negative capability states during smoke and local admin runs.

### 5. Keep dialog-driven consumers hydrated when sheet metadata changes

The import modal bug showed that a successful `loadSheetMeta()` was not enough if dependent view-model state remained stale.

`MultitableWorkbench.vue` now mirrors refreshed field metadata back into `grid.fields` while dialogs remain open. This keeps:

- import mapping labels
- field-manager/view-manager config UIs
- other overlay consumers of field metadata

consistent with the latest sheet schema.

### 6. Make smoke assertions match legal reconcile paths

Field/view manager reconcile logic has two valid behaviors:

- dirty local draft present: show warning and require reload
- no effective dirty draft: auto-refresh to latest config and show refresh notice

The smoke harness previously assumed only the warning path. It now accepts either path while still requiring the final reconciled schema/config to be correct.

This is intentionally stronger than a brittle “one exact DOM path” assertion, because it validates business outcome instead of timing artifacts.

### 7. Make people/import retry smoke self-seeding and deterministic

Fresh databases had no selectable person records. The smoke harness now self-seeds a minimal admin user when the people preset returns no selectable options.

The retry simulation was also updated to fail the retry row twice so that the UI’s built-in transport retry is exhausted before the manual retry UX is asserted.

### 8. Report the requested embed navigation target, not a stale snapshot

The first successful `mt:navigate` smoke inside the iframe was still timing out on `waitForEmbedFrameContext()`. The host was emitting `mt:navigate-result` with the old view because it trusted `getEmbedHostStateSnapshot().currentContext` immediately after a successful navigation request, before the route layer had actually moved.

The fix is to make the applied context authoritative:

- `MultitableWorkbench.vue` now returns the requested `nextContext` after a successful `requestExternalContextSync()`
- busy/deferred replay also emits the replay target instead of recomputing from a possibly stale snapshot
- `MultitableEmbedHost.vue` now trusts `result.context` / `payload.context` for applied results

This closes the contract gap between `mt:navigate-result` and the actual requested target.

### 9. Sync embed host overrides back into the real router URL

Even after the applied context fix, the iframe route itself could stay on the old path because `MultitableEmbedHost.vue` only updated internal override refs, not the Vue Router location. That made the workbench props correct while the actual iframe URL remained stale.

The fix is to couple override application with `router.replace()` for the multitable route:

- path params now move to the target `sheetId/viewId`
- `baseId` query stays authoritative
- transient `recordId` and `mode` query parameters are dropped during host-driven navigation so a prior forced form/deep-link context does not pin the target view to the old mode

This makes host navigation visible at all three layers:

- emitted `mt:navigate-result`
- internal workbench props
- actual iframe URL / router state

## Files

Primary runtime files:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/core-backend/src/routes/univer-meta.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/core-backend/src/db/migrations/zzzz20260326124000_add_config_to_meta_views.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/core-backend/src/db/migrations/zzzz20260326134000_create_meta_comments.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/api/client.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableEmbedHost.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/verify-multitable-live-smoke.mjs`

Primary test files:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/core-backend/tests/integration/multitable-context.api.test.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/core-backend/tests/integration/comments.api.test.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-comments.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-embed-host.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-import-flow.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts`

## Outcome

This slice moved `multitable-next` past reference parity in a stronger way than simple feature matching:

- fresh-database runtime gaps are now formal migrations
- comments, people-import, field-manager, view-manager, and embed-host flows all execute in a real browser against a real API/database
- host navigation now keeps emitted protocol, internal state, and real iframe route aligned
- the local pilot runner now finishes green end-to-end instead of stopping at late-stage embed replay drift
