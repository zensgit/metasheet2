# PLM Workbench Audit Team View Save Owner Draft Design

## Background

`audit team view` save already pivots the UI onto the newly persisted canonical team view. After the previous lifecycle cleanup fix, `duplicate` and `rename` both clear the name draft and owner draft together.

## Problem

`persistAuditTeamView(...)` still only cleared the name draft. If a user had typed a transfer-owner draft before saving a new audit team view, the stale owner input survived the successful save and leaked onto the newly managed target.

## Decision

Reuse the canonical post-success cleanup helper `resolvePlmAuditCompletedTeamViewFormDraftState()` for the save success path as well, instead of clearing only the name draft.

## Expected Outcome

After a successful audit team-view save, the form returns to a clean post-success state:

- `draftTeamViewName` cleared
- `draftTeamViewNameOwnerId` cleared
- `draftOwnerUserId` cleared

This keeps save/duplicate/rename aligned under one lifecycle contract.
