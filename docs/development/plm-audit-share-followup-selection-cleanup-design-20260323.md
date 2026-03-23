# PLM Audit Share Followup Selection Cleanup Design

## Background

`3c513dfeb fix(plm-audit): clear default followup selection residue` already removed batch selection from the `set-default-followup` handoff.

The `share` path still had one leftover selection leak.

## Problem

`buildPlmAuditTeamViewCollaborationHandoff(..., { mode: 'draft' })` auto-selects the target team view when the row is selectable.

When the user then clicks `share` from that collaboration draft:

- the draft is replaced by a share followup
- focus stays on the team view
- but the auto-installed single-row batch selection remains

That leaves stale batch UI behind:

- the page still shows `Selected 1 / ...`
- batch archive/restore/delete actions remain visually active

The followup is only about share/log review, not batch lifecycle management.

## Decision

Clear only the draft-owned auto selection when a `share` followup replaces a collaboration draft.

Keep the behavior narrow:

- if selection is exactly the auto-installed single row for the draft target, clear it
- if the user has already changed selection to multiple rows, preserve it
- `set-default` behavior stays unchanged because that path is already normalized

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- add `resolvePlmAuditTeamViewFollowupSelection(...)` as a pure helper
- call it before replacing a collaboration draft with a share followup
- clear only the draft-owned single selection for the matching team view

## Expected Behavior

- `draft -> share followup` no longer leaves `Selected 1 / ...` residue behind
- share followups keep visual focus, but not batch lifecycle selection
- manually changed multi-select state is preserved
