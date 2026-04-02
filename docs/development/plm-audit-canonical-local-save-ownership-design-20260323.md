# PLM Audit Canonical Local Save Ownership Design

Date: 2026-03-23

## Goal

Make generic `Save current view` derive its source-aware followup from the canonical audit route, not from the local team-view selector.

## Problem

`apps/web/src/views/PlmAuditView.vue` resolves the generic local-save followup through `resolvePlmAuditSavedViewLocalSaveFollowupSource(...)`.

Before this change, the shared-entry branch depended on `auditTeamViewKey`, which is only the local selector state. That created a mismatch:

- canonical audit route still belonged to shared-entry team view `A`
- the user temporarily browsed the selector to team view `B` without applying it
- generic `Save current view` still persisted canonical route `A`
- but the source resolver returned `null`, so the UI skipped the shared-entry local-save followup and left the shared-entry notice alive

The saved content and the takeover semantics diverged.

## Decision

Treat generic local save as source-aware based on canonical route ownership.

Rules:

- if the current route still points at the shared-entry owner, generic local save is a shared-entry takeover
- otherwise, shared-entry followup does not apply
- scene-context still remains the fallback when no shared-entry route owner is active

This keeps generic local save aligned with what it actually persists: the current canonical audit route.

## Implementation

Files:

- `apps/web/src/views/PlmAuditSavedViewShareFollowup.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewShareFollowup.spec.ts`

Key changes:

- change `resolvePlmAuditSavedViewLocalSaveFollowupSource(...)` to compare `sharedEntryTeamViewId` against `routeTeamViewId`
- in `saveCurrentAuditView()`, pass `readCurrentRouteState().teamViewId` instead of the local selector key
- extend the pure helper regression to cover canonical shared-entry ownership even when selector-driven assumptions would have returned `null`

## Expected Outcome

- generic `Save current view` and dedicated shared-entry `Save as local view` now agree whenever they save the same canonical shared-entry route
- temporary local selector drift no longer suppresses the correct shared-entry takeover path
