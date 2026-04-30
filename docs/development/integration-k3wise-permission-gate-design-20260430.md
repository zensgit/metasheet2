# K3 WISE Setup Permission Gate Design - 2026-04-30

## Context

The K3 WISE setup page is the operator-facing entry point for external systems,
pipeline templates, staging installation, dry runs, and live pipeline runs.
Backend integration routes already enforce the `integration:*` permission model,
but the frontend route and shell entry were still tied to the older
`attendanceAdmin` feature gate.

That mismatch created two bad states:

- A user with `integration:write` could use the backend API but could not see or
  open the K3 WISE setup page.
- A user with `attendanceAdmin` but no `integration:*` permission could open the
  page, then hit backend `403` responses on save/install/run actions.

## Decision

Gate the K3 WISE setup entry with `integration:write`, not `integration:read`.

Reasoning:

- The current page is a setup console, not a read-only dashboard.
- The page exposes write actions including external-system upsert, credential
  test, staging install, pipeline upsert, dry run, and run.
- A read-only entry would require action-level UI disabling for every write
  control. That can be added later as a dedicated read-only mode, but it is not
  the smallest safe internal-trial fix.

## Implementation

Changed files:

- `apps/web/src/composables/useAuth.ts`
  - Adds `hasPermission(requiredPermission)`.
  - Mirrors backend-compatible hierarchy:
    - `snapshot.isAdmin` and role `admin` allow all permission checks.
    - Exact permission and `*:*` allow the check.
    - `resource:*` allows every action in the resource.
    - `resource:admin` allows resource actions and exact admin checks.
    - `resource:write` allows `resource:read`.

- `apps/web/src/main.ts`
  - Reads `to.meta.permissions`.
  - Blocks routes when any required permission is missing.

- `apps/web/src/router/appRoutes.ts`
  - Changes `/integrations/k3-wise` from the `attendanceAdmin` feature gate to
    `permissions: ['integration:write']`.

- `apps/web/src/App.vue`
  - Shows the ERP integration navigation entry when
    `hasPermission('integration:write')` is true.

## Non-Goals

- This does not implement a read-only K3 WISE setup mode.
- This does not change backend RBAC; it aligns frontend gating with the existing
  backend integration route contract.
- This does not change customer GATE requirements or K3 WISE live-connection
  behavior.

## Follow-Up

For internal staging signoff, the next non-customer blocker is deployment
evidence:

- Run the K3 postdeploy smoke with authenticated checks enabled.
- Ensure the target tenant has integration permissions seeded for the test
  operator.
- Treat public-only smoke as insufficient for internal trial signoff.
