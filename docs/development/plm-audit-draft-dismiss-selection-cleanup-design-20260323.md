# PLM Audit Draft Dismiss Selection Cleanup Design

## Background

`PLM Audit` already clears draft-owned batch selection when a collaboration draft turns into:

- a `share` followup
- a `set-default` followup

Those fixes established the rule that source-driven collaboration notices should not leave hidden lifecycle selection behind once the draft flow is over.

## Problem

The plain `dismiss` path still kept one residue.

`buildPlmAuditTeamViewCollaborationHandoff(..., { mode: 'draft' })` auto-selects the target row when the row is selectable.

If the user then clicks `Done` on the collaboration draft notice:

- the draft disappears
- focus is cleaned up
- but the auto-installed single-row batch selection stays behind

That leaves the page in a stale mixed state where:

- the collaboration notice is gone
- `Selected 1 / ...` is still visible
- batch archive/restore/delete actions remain active even though the source-driven draft was explicitly dismissed

## Decision

Treat draft dismissal the same way as the followup cleanup path:

- if selection is exactly the draft-owned single row, clear it
- if the user already changed selection to a broader multi-select, preserve it

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- add `resolvePlmAuditTeamViewDismissedDraftSelection(...)` as a pure helper
- call it before clearing the collaboration draft in `dismissAuditTeamViewCollaborationDraft()`
- keep the attention cleanup unchanged

## Expected Behavior

- `draft -> dismiss` no longer leaves `Selected 1 / ...` residue behind
- dismiss still clears collaboration focus
- user-owned multi-select state is preserved
