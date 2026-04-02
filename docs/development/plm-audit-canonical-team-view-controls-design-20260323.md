# PLM Audit Canonical Team View Controls Design

Date: 2026-03-23

## Goal

Keep generic team-view controls aligned with the canonical audit route owner, and stop shared-entry notice actions from inheriting selector-local draft names.

## Problem

Two related ownership leaks still existed in `apps/web/src/views/PlmAuditView.vue`:

- generic `Team views` controls still acted on the selector-local target even when the canonical route still belonged to another team view
- shared-entry notice `Duplicate for my workflow` already resolved the correct canonical target, but it still reused `auditTeamViewName` from the local controls as the duplicate name override

That let the page say “you are acting on canonical shared-entry A” while management actions or duplicate payload still came from local selector drift on `B`.

## Decision

Treat selector drift as a read-only preview until the user explicitly applies it.

Rules:

- when `selectedTeamViewId !== routeTeamViewId`, generic management controls are disabled
- `Apply` stays available so the user can intentionally pivot the canonical owner
- shared-entry notice duplicate ignores local draft names and falls back to the canonical target’s normal duplicate naming path

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewControlTarget.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

Key changes:

- add `shouldLockPlmAuditTeamViewManagementTarget(...)` for selector-drift gating
- add `resolvePlmAuditTeamViewDuplicateName(...)` so canonical shared-entry duplicate can explicitly ignore local draft names
- gate `Duplicate / Share / Set default / Clear default / Delete / Archive / Restore / Rename / Transfer owner` behind the drift lock
- show a small inline hint telling the user to apply the selected team view first

## Expected Outcome

- route owner and management target no longer diverge silently
- shared-entry duplicate actions no longer mix a canonical target with selector-local payload data
