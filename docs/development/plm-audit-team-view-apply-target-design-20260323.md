# PLM Audit Team View Apply Target Design

## Background

`PLM Audit` has two different team-view target semantics:

- generic management actions operate on the canonical route owner
- `Apply` promotes the local selector into the canonical route

Earlier canonical-owner tightening accidentally moved `Apply` onto the same canonical target as `Rename`, `Share`, `Delete`, and the other management actions.

## Problem

Once `Apply` reads the canonical owner instead of the local selector:

- the button can become disabled when the selector already points at a valid team view but the route still has no owner
- recommendation/manage handoffs can seed selector `B` while the route still points at `A`, and `Apply` will incorrectly replay `A`

That breaks the explicit UI contract that users should select a team view locally and then apply it before running management actions.

## Decision

Keep the split semantics explicit:

- `Apply` resolves against the local selector first
- if the selector is empty or stale, `Apply` may fall back to the canonical owner
- all generic management actions remain bound to the canonical owner

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewControlTarget.ts`
- `apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

Key changes:

- add `resolvePlmAuditTeamViewApplyTarget(...)`
- compute `auditTeamViewApplyTarget` separately from `canonicalAuditTeamViewManagementTarget`
- wire `canApplyAuditTeamView` and `applyAuditTeamView()` to that apply target
- add a focused spec that locks selector-first apply resolution

## Expected Behavior

- when selector = `B` and route owner = `A`, `Apply` targets `B`
- when selector is empty, `Apply` falls back to the canonical owner if one exists
- `Duplicate`, `Share`, `Set default`, `Delete`, `Archive`, `Restore`, `Rename`, and `Transfer owner` continue to use canonical ownership
