# After-sales Runtime And Follow-up Development Report (2026-04-10)

## Overview
Delivered the next after-sales mainline batch across four PRs:

- `#780` runtime installer adapters for automation registry and RBAC provisioning
- `#782` field policy read path and `refundAmount` UI gating
- `#777` inline follow-up edit flow
- `#778` follow-up due notification proof and payload fallback hardening

This batch intentionally stayed inside the existing after-sales vertical slice. It did not introduce a generic workflow engine, a generic field-policy read API, or a broader UI redesign.

## Key Capabilities
### 1) Installer Runtime Adapters (`#780`)
- Added install-time persistence seams for plugin automation rules and after-sales role/field-policy matrices.
- Persisted automation state in a plugin automation registry table and RBAC/field policies in plugin-scoped registry tables.
- Wired installer warnings so adapter failures degrade to `partial` with warnings instead of collapsing the whole install path.
- Hardened runtime semantics:
  - removed automation rules are retired during sync instead of staying enabled forever
  - RBAC provisioning writes plugin/app namespaced role ids instead of mutating global `admin` / `finance` / `supervisor` / `viewer`

### 2) Field Policy Consumption (`#782`)
- Added a plugin-local `GET /api/after-sales/field-policies` route.
- Computed effective `refundAmount` visibility/editability from install-time field policy registry rows with blueprint fallback for legacy installs.
- Updated `AfterSalesView.vue` to consume the policy result:
  - `hidden` hides the refund control path
  - `readonly` shows but disables the control path
  - `editable` keeps the current behavior

### 3) Follow-up Edit Flow (`#777`)
- Added `PATCH /api/after-sales/follow-ups/:followUpId` for partial follow-up updates.
- Added inline follow-up edit UI and diff-only payload submission in `AfterSalesView.vue`.
- Locked the normalization contract for clearing optional follow-up fields:
  - cleared values normalize to `null`
  - they do not round-trip as empty strings

### 4) Follow-up Due Proof (`#778`)
- Extended `followup.due` payload building so logical follow-up records can provide ownership through `ownerName` fallback.
- Added route-level coverage for the fallback behavior.
- Added real integration proof for:
  - create ticket
  - create follow-up
  - emit `followup.due`
  - dispatch `notificationService.send`
- Tightened the validation error copy so the accepted owner sources are explicit: `followUpOwner` and `ownerName`.

## Contract Decisions
- Installer runtime adapter persistence is authoritative enough to drive after-sales runtime gating, but still falls back to existing default-enabled runtime behavior when registry lookup fails.
- Field policy reads remain plugin-local in this batch. No generic core field-policy read API was introduced.
- Role ids provisioned for after-sales are plugin/app namespaced to avoid polluting platform-global RBAC rows.
- Optional follow-up fields normalize to `null` when cleared.
- `followup.due` accepts both explicit recipient input (`followUpOwner`) and logical record fallback (`ownerName`).

## Merge Record
- `#780` merged to `main` as `e4a10ba4c441985b542c1ccde3780d4d3d7293c8`
- `#782` merged to `main` as `40abae49d2cc311f5368413078ae1826a35e6d0c`
- `#777` merged to `main` as `3ec53961c44d6eab1bc5ac0c2fdffce9198aac6f`
- `#778` merged to `main` as `59e0d415407e356a01e0a2d4f776762079519200`

## Non-goals Preserved
- No scheduler/cron for due follow-ups
- No generic automation expression engine
- No generic core field-policy read endpoint
- No broader `AfterSalesView` component split or redesign
- No change to the cleared-follow-up-field `null` contract
