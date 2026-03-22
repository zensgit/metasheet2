# PLM Audit Saved-View Followup Installation Design

Date: 2026-03-22

## Goal

Keep local saved-view followups transient and source-aligned when the audit page installs a fresh followup from:

- `scene-context -> Save as local view`
- `shared-entry -> Save as local view`

## Problem

The saved-view area already treats local followups and saved-view focus as transient guidance, but the installation path for a new local followup still wrote `auditSavedViewShareFollowup` directly in `PlmAuditView.vue`.

That left one gap:

1. the page could already hold `focusedSavedViewId` from an earlier `focus-source` followup
2. a new scene quick-save or shared-entry local save created another saved-view followup
3. the new notice appeared, but the previous saved-view card could stay focused at the same time

The result was inconsistent attention in the saved-view list and a broken “single active source guidance” rule.

## Design

### 1. Model local followup installation as a reducer action

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes an explicit `install-followup` action.

That action:

- installs the new `shareFollowup`
- clears stale `focusedSavedViewId`

This keeps saved-view-followup replacement in the same reducer that already owns saved-view attention cleanup.

### 2. Consume stale source focus before installing the new local followup

`PlmAuditView.vue` should treat a new local saved-view followup as a source takeover.

Before installing the new followup, the page now clears source focus so:

- stale recommendation focus disappears
- stale saved-view focus disappears
- the new local followup becomes the only active saved-view guidance

### 3. Keep scope narrow

This slice does not change route state, persistence contracts, or promotion semantics.

It only tightens transient UI state for newly installed local saved-view followups.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- new scene quick-save local followups replace prior saved-view focus residue
- shared-entry local saves use the same replacement rule
- the saved-view list shows one coherent local followup target instead of mixed old/new focus
