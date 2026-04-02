# PLM Workbench Team Preset Hydration Selection Design

## Background

`team preset` hydration takeover/removal already cleared selector and management drafts when the route owner changed, but it still handled batch selection as an all-or-nothing side effect through `clearTeamPresetSelection()`.

That left a parity gap versus:

- `team view` hydration helpers
- local preset hydration helpers

Both of those already trim stale selection ids precisely instead of dropping or preserving the whole batch state blindly.

## Problem

When route hydration changed a team preset owner from `A -> B`, or removed `A` from the route while local pending selection already targeted `B`, the page could keep stale batch selection entries for `A`.

That meant subsequent batch `archive / restore / delete` actions still targeted an owner that was no longer authoritative.

## Design

### Helper contract

Extend:

- `resolvePlmHydratedTeamPresetOwnerTakeover(...)`
- `resolvePlmHydratedRemovedTeamPresetOwner(...)`

with:

- `localSelectionIds`
- `nextSelectionIds`

The selection rules mirror existing `team view` semantics:

- route owner `A -> B`
  - if local selector already equals `B`, keep only `B`
  - if local selector targets another id, clear selection entirely
- route owner `A -> none`
  - remove only `A`
  - preserve other pending local selection ids

### Page integration

`PlmProductView.vue` stops calling blanket `clearTeamPresetSelection()` inside hydration takeover/removal. Instead it writes back the helper’s exact `nextSelectionIds`.

## Why this is the right fix

- Aligns `team preset` behavior with the already-correct `team view` and local preset hydration paths
- Avoids stale batch targets without destroying valid pending local selection
- Keeps route hydration authoritative while preserving the user’s still-valid local management intent
