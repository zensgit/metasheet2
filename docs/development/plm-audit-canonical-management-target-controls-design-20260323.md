# PLM Audit Canonical Management Target Controls Design

## Background

`PLM Audit` keeps a canonical team-view owner in two places:

- `route.query.auditTeamView` when the page is on a concrete team-view route
- `auditTeamViewCollaborationFollowup.teamViewId` when the page has already pivoted into a default/log follow-up route

Recent route-preservation fixes kept that canonical owner alive, but the generic controls in `PlmAuditView.vue` still derived their actionable entry from the local selector `selectedAuditTeamView`.

## Problem

When a user runs `Set default` or `Clear default`, the page intentionally moves to an audit-log route that clears the local selector. At that point:

- the canonical owner still exists through the follow-up state
- the generic controls row should still refer to that same team view
- but `selectedAuditTeamView` becomes `null`

That makes `Share`, `Duplicate`, `Rename`, `Transfer owner`, `Archive`, `Restore`, `Delete`, `Set default`, and `Clear default` incorrectly lose their target even though the page still has a stable canonical team-view owner.

## Decision

Introduce an explicit canonical management target resolver and use it for generic management controls.

## Implementation

### Helper

Add `resolvePlmAuditCanonicalTeamViewManagementTarget(...)` to `plmAuditTeamViewControlTarget.ts`.

It resolves the actionable entry from:

1. `route.query.auditTeamView`
2. fallback `auditTeamViewCollaborationFollowup.teamViewId`

### View wiring

In `PlmAuditView.vue`:

- add `canonicalAuditTeamViewManagementTarget`
- drive generic management permissions from the canonical target
- run generic management actions against the canonical target instead of the local selector
- drive `Apply` from the canonical target as well, so follow-up/log routes do not lose it when the selector is cleared

## Expected Behavior

- `Apply` and the generic management controls act on the canonical owner
- when the selector drifts away from an applied route owner, `auditTeamViewManagementTargetLocked` still blocks management actions
- when the selector is cleared by a log/follow-up route, the canonical follow-up owner still keeps the generic controls actionable
