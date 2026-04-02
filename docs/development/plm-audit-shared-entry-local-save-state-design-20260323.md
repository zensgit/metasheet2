# PLM Audit Shared-Entry Local Save State Design

Date: 2026-03-23

## Goal

Make shared-entry local saves persist the canonical shared-entry route state instead of any temporary local selector drift.

## Problem

`apps/web/src/views/PlmAuditView.vue` already resolves shared-entry notice actions against the canonical entry target, but the local-save path still called `saveCurrentLocalViewWithFollowup(...)` without a canonical state override.

That left two mismatches:

- shared-entry notice `Save as local view` could still persist a selector-polluted state
- generic `Save current view` could resolve shared-entry ownership from the route marker, but still save the selector-mutated local state

So the followup owner and the persisted state could diverge.

## Decision

When the local-save source is `shared-entry`, always persist the canonical route state.

Rules:

- shared-entry ownership is still derived from the canonical route
- a shared-entry local save persists the canonical audit route, not the temporary selector state
- scene-context and generic local saves keep persisting the current local audit state

## Implementation

Files:

- `apps/web/src/views/plmAuditSavedViewShareFollowup.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewShareFollowup.spec.ts`

Key changes:

- add `resolvePlmAuditSavedViewLocalSaveState(...)` as the pure state-selection helper
- use canonical route state for shared-entry notice local-save
- use canonical route state for generic `Save current view` whenever the resolved source is `shared-entry`
- extend the pure regression to lock shared-entry versus scene-context persistence behavior

## Expected Outcome

- shared-entry local-save followups and the saved route snapshot now point at the same canonical owner
- temporary selector drift no longer changes what shared-entry local-save persists
