# PLM Workbench Approval Comment Snapshot Design

## Problem

The recent approvals fix localized `approvalComment` at the approvals team-view layer, but the top-level workbench
snapshot still treated `approvalComment` as collaborative query state.

That left an inconsistent ownership model:

- approvals team views ignored `approvalComment`
- workbench team views still serialized and matched `approvalComment`

So a local approvals draft could still invalidate an otherwise matching `workbenchTeamView`, and shared workbench links
could still persist a one-off approval comment.

## Decision

1. Treat `approvalComment` as local-only at the workbench snapshot layer too.
2. Strip `approvalComment` inside `normalizePlmWorkbenchCollaborativeQuerySnapshot(...)`.
3. Keep `approvalComment` in local query normalization so standalone local deep links still work.

## Expected Behavior

- workbench team-view matching ignores approval draft text
- workbench team-view share URLs do not include `approvalComment`
- local approvals comment drafts no longer dirty collaborative workbench ownership
