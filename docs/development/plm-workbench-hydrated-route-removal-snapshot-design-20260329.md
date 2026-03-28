# PLM Workbench Hydrated Route Removal Snapshot Design

## Problem

`PlmProductView.vue` resets hydrated route-owner refs at the beginning of `applyQueryState()`. The same function later used those refs to decide whether a route owner had been removed from the URL. That made the `A -> none` removal branches unreachable for:

- panel team views
- team presets
- local filter presets

The pure removal helpers were already correct; the control-flow around them was not.

## Design

Capture the previous hydrated route-owner snapshot before resetting query refs, then drive each branch through a shared transition resolver:

- `apply` when the next query explicitly carries a value
- `remove` when the next query omits a previously hydrated value
- `noop` when there is nothing to hydrate or remove

This keeps route-removal semantics aligned across team views, team presets, and local presets without re-duplicating ad hoc `previous value` handling in `PlmProductView.vue`.

## Scope

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmHydratedRouteQueryTransition.ts`
- `apps/web/tests/plmHydratedRouteQueryTransition.spec.ts`
