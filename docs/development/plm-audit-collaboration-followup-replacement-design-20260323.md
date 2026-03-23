# PLM Audit Collaboration Followup Replacement Design

Date: 2026-03-23

## Goal

Make a newly created collaboration `share` followup replace any older collaboration draft instead of letting both owners coexist.

## Problem

`apps/web/src/views/PlmAuditView.vue` renders collaboration drafts and collaboration followups in separate notice regions.

Before this change, `shareAuditTeamViewEntry(...)` installed a new followup but did not clear an existing draft first. That left two stale-state cases:

- recommendation management draft on team view `A` + recommendation share followup on team view `B`
- hidden same-view draft on `A` that could reappear after dismissing the share followup on `A`

The current cleanup only handled same-view draft handoff from `runAuditTeamViewCollaborationAction(...)` and route-driven pivots. Direct recommendation share actions bypassed both.

## Decision

Treat a newly created collaboration followup as the new collaboration owner.

Rules:

- when a `share` action produces a followup, any existing collaboration draft is cleared first
- this applies whether the followup points at the same team view or a different team view
- route-driven cleanup remains unchanged; this only closes the page-local handoff gap

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- add `shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(...)` as the pure handoff rule
- call that helper inside `shareAuditTeamViewEntry(...)` before installing the new followup
- extend the collaboration helper regression to cover both same-view and cross-view replacement

## Expected Outcome

- recommendation share on `B` no longer leaves recommendation draft `A` visible
- same-view share followups no longer allow hidden drafts to reappear after dismiss
- collaboration draft/followup ownership is single-source again
