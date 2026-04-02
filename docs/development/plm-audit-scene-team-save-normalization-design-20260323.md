# PLM Audit Scene Team Save Normalization Design

Date: 2026-03-23

## Goal

Complete the scene-owned save contract by making `Save to team` and `Save as default team view` store canonical scene team-view state, not whatever drifted audit query happens to be on screen.

## Problem

The previous local-save fix normalized `Save scene view`, but the team-view half of the same scene save surface still saved the current route verbatim.

That left one user-visible mismatch:

- `Save scene view` stored a canonical scene snapshot
- `Save to team` / `Save as default team view` still persisted drifted audit filters while the UI copy continued to describe them as scene-focused team views

## Decision

Use the same scene normalization rule for team-view saves that we now use for local scene saves.

- if owner-context is active, save owner-context team-view state
- otherwise save scene-query team-view state when a scene query exists
- otherwise fall back to owner-based team-view state when only owner metadata survives

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSceneContext.ts`
- `apps/web/tests/plmAuditSceneContext.spec.ts`

Key changes:

- add `buildPlmAuditSceneTeamViewState(...)` on top of the existing canonical scene saved-view normalization
- allow `persistAuditTeamView(...)` to accept an explicit team-view state override
- route `runAuditSceneSaveAction('team-view' | 'team-default')` through that canonical scene team-view state instead of persisting the drifted current route

## Expected Outcome

- scene team views now restore canonical scene owner/query filters after save
- `Save scene view`, `Save to team`, and `Save as default team view` all follow the same scene-owned snapshot contract
- scene copy and saved behavior no longer diverge between local and team/default save paths
