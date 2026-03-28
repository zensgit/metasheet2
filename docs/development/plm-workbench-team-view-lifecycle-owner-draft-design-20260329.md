# PLM Workbench Team View Lifecycle Owner Draft Design

Date: 2026-03-29
Commit: pending

## Context

`team view` lifecycle handling had already been tightened for archive, restore, transfer, and several refresh paths, but one asymmetry remained in the success path of two management actions:

- `duplicateTeamView()`
- `renameTeamView()`

Both actions clear the name draft after a successful mutation, but they previously left `teamViewOwnerUserId` untouched.

That created a real state mismatch:

- a user enters a transfer target owner
- then successfully duplicates or renames the selected team view
- the UI moves on to the new or renamed canonical target
- the stale owner-transfer draft remains and can be accidentally submitted to the next transfer action

The matching `team preset` flow had already normalized this family of residue by clearing both name and owner drafts after successful lifecycle actions.

## Decision

Align `team view` lifecycle cleanup with the existing `team preset` behavior:

- clear `teamViewOwnerUserId` after successful duplicate
- clear `teamViewOwnerUserId` after successful rename

## Why This Fix

- It removes a real stale draft carry-over, not just a cosmetic inconsistency.
- It keeps the write scope minimal and local to the affected success branches.
- It preserves existing selection and apply semantics while eliminating a stale transfer target.
- It restores parity with the already-cleaned `team preset` lifecycle flow.

## Scope

Included:

- `apps/web/src/views/plm/usePlmTeamViews.ts`
- `apps/web/tests/usePlmTeamViews.spec.ts`

Not included:

- no backend change
- no OpenAPI/SDK change
- no broader behavior change for failed lifecycle actions
