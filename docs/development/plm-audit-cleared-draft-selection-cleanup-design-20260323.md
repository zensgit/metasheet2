# PLM Audit Cleared Draft Selection Cleanup Design

## Background

`PLM Audit` already cleared draft-owned single-row batch selection when:

- a collaboration draft became a `share` followup
- the user explicitly dismissed the collaboration draft

But draft ownership can also disappear through other paths:

- route pivots that invalidate the draft owner
- successful `share` / `set-default` actions that replace the draft
- shared-entry or canonical-owner takeovers that clear the current draft

## Problem

Those non-dismiss paths still called `clearAuditTeamViewCollaborationDraft()` directly.

Before this change, that helper only nulled the draft object. It did not consume the auto-installed single-row selection that came from the draft handoff.

That left the page in a stale mixed state:

- the collaboration draft notice was gone
- `Selected 1 / ...` could still remain
- batch lifecycle actions stayed active even though the draft owner had already been cleared

## Decision

Promote the cleanup rule to all draft-clear paths:

- if the current selection is exactly the draft-owned single row, clear it whenever draft ownership is cleared
- if the user already changed selection to multi-select or another row, preserve it

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- replace the dismiss-specific reducer with `resolvePlmAuditClearedTeamViewDraftSelection(...)`
- apply that reducer inside `clearAuditTeamViewCollaborationDraft()`
- let every existing call site inherit the same cleanup contract

## Expected Behavior

- explicit `Done` still clears the draft-owned single selection
- route-driven or action-driven draft cleanup now clears the same residue
- user-managed multi-select state is preserved
