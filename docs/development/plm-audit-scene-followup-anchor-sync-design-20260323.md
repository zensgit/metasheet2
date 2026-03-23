# PLM Audit Scene Followup Anchor Sync Design

Date: 2026-03-23

## Goal

Keep `scene-context` collaboration followups actionable after the scene banner appears or disappears, without leaving stale `Back to scene context` actions behind.

## Problem

`buildPlmAuditTeamViewCollaborationFollowup(...)` snapshots `sourceAnchorId` at creation time.

That is correct when the followup is created, but it becomes stale if the page later pivots scene context:

1. a scene-driven collaboration followup is created while `plm-audit-scene-context` exists
2. the user clears or changes scene context
3. the followup still points at `plm-audit-scene-context`, even though the banner is gone

The visible result is stale copy and a `Back to scene context` action that scrolls to a dead anchor.

## Design

### 1. Re-resolve scene-context anchors from current availability

`apps/web/src/views/plmAuditTeamViewCollaboration.ts` now exposes `syncPlmAuditTeamViewCollaborationFollowupSourceAnchor(...)`.

It only rewrites followups whose `source === 'scene-context'`, recomputing `sourceAnchorId` from current `sceneContextAvailable`.

Other followup sources remain untouched.

### 2. Apply the sync at read time in the page layer

`apps/web/src/views/PlmAuditView.vue` now resolves the followup through this helper before:

- rendering the collaboration followup notice
- executing followup actions such as `focus-source`

This keeps the UI and action path aligned with current scene-banner availability without introducing another mutable watcher.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `docs/development/plm-audit-scene-followup-anchor-sync-design-20260323.md`
- `docs/development/plm-audit-scene-followup-anchor-sync-verification-20260323.md`

## Expected Outcome

- scene-driven share followups fall back to `Back to team view controls` when the scene banner is gone
- followup copy stays accurate after route/query transitions that remove scene context
- non-scene collaboration followups keep their existing provenance behavior
