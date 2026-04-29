# K3 WISE Setup Guard Design - 2026-04-29

## Goal

Close two small but customer-visible setup-page gaps on `/integrations/k3-wise`:

- `LCID` and `Timeout ms` are entered by an operator, but the payload helper previously converted invalid values to defaults. That made a typo look like a successful save while the actual adapter config used `2052` or `30000`.
- The shell navigation already showed the K3 WISE setup page only to admin-capable users, but the route itself did not carry the same feature guard.

The setup page should fail fast before saving invalid transport config, and direct navigation should follow the same admin gate as the visible nav entry.

## Scope

Changed files:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `apps/web/tests/platform-shell-nav.spec.ts`

## Behavior

- `validateK3WiseSetupForm()` now requires `lcid` and `timeoutMs` to be positive integers.
- `buildK3WiseSetupPayloads()` now uses the same strict contract and throws if called directly with invalid numeric transport fields.
- Existing defaults remain unchanged:
  - `lcid`: `2052`
  - `timeoutMs`: `30000`
- `/integrations/k3-wise` now carries `requiredFeature: 'attendanceAdmin'`, matching the existing `ERP 对接` nav visibility rule in `App.vue`.

## Why Frontend / Shell Only

The backend K3 WISE adapter still keeps defensive defaults for config loaded from older rows or hand-written fixtures. This change is specifically for the operator-facing setup page, where silently replacing a typed value creates avoidable confusion during the customer GATE/live PoC handoff.

Backend integration routes already enforce integration permissions in the plugin route layer. The route-meta change is a frontend shell guard so ordinary authenticated users cannot open the operator setup surface directly.

## Out Of Scope

- Changing adapter runtime defaults.
- Adding min/max ranges for timeout tuning.
- Live K3 WISE connection validation.
