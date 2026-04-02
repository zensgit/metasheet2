# PLM Workbench Audit Team View Lifecycle Owner Draft Design

## Background

`audit team view` management already cleared the rename name draft after successful `duplicate` and `rename`, but it did not clear the transfer-owner draft. After the mutation pivoted the UI onto the duplicated or renamed target, the stale owner input could leak into the next management target.

## Problem

This behavior diverged from the main `usePlmTeamViews` lifecycle cleanup that already clears both name and owner drafts on successful lifecycle mutations. The audit panel therefore kept a stale `auditTeamViewOwnerUserId` even though the canonical management target had moved.

## Decision

Introduce a small canonical cleanup helper in `plmAuditTeamViewOwnership.ts` that represents the post-success form state for audit team-view lifecycle mutations:

- clear `draftTeamViewName`
- clear `draftTeamViewNameOwnerId`
- clear `draftOwnerUserId`

Use this helper in `PlmAuditView.vue` after successful `duplicateAuditTeamViewEntry(...)` and `renameAuditTeamView()`.

## Expected Outcome

After duplicate or rename succeeds, the audit team-view management form returns to a clean post-success state and no stale transfer-owner draft is carried into the next target.
