# PLM Audit Shared Entry Local Save Consumption Design

Date: 2026-03-23

## Goal

Make generic `Save current view` behave consistently with the dedicated shared-entry `Save as local view` action when the user is still looking at the same shared team view.

## Problem

`apps/web/src/views/PlmAuditView.vue` had two local-save paths:

- the shared-entry notice CTA in `runAuditTeamViewShareEntryAction('save-local')`
- the always-visible generic `saveCurrentView()`

Only the dedicated shared-entry CTA consumed:

- `auditTeamViewShareEntry`
- the transient `auditEntry=share` route marker

The generic local-save path only called `storeAuditSavedView(...)`, so in a shared-link session the user could save the current view locally and still keep the shared-entry banner plus `auditEntry=share` in the URL.

## Decision

Treat generic local save as a shared-entry takeover only when the current local team-view selection still matches the shared-entry owner.

That guard is important because canonical route ownership is already stricter than local selector state:

- if the user is still on the shared team view, generic local save should consume the shared-entry state
- if the user has only browsed the selector to another local team view without applying it, generic local save should not consume the original shared-entry owner

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Key changes:

- add `shouldTakeOverPlmAuditSharedEntryOnLocalSave(...)`
- make `saveCurrentView()` delegate to async `saveCurrentAuditView()`
- after `storeAuditSavedView(...)`, install the same `shared-entry` saved-view followup and consume `auditEntry=share` when the current selected team view still matches the shared-entry owner

## Expected Outcome

- `shared-entry -> Save current view` now produces the same takeover semantics as the dedicated notice CTA
- generic local saves on other team views do not accidentally consume an unrelated shared-entry owner
