# PLM Workbench Audit Team View Operation Feedback Design

Date: 2026-03-29
Commit: pending

## Context

The previous audit team view feedback pass only covered lifecycle/default management:

- `set default`
- `clear default`
- `archive`
- `restore`
- `delete`

But the remaining operation handlers in `PlmAuditView.vue` still contained silent returns:

- `applyAuditTeamView()`
- `duplicateAuditTeamView()`
- `shareAuditTeamView()`
- `renameAuditTeamView()`
- `transferAuditTeamView()`

That left the audit panel behind the workbench team view/team preset flows, where direct handler calls already surface explicit selection, restore-first, readonly, and input-validation feedback.

## Decision

Extend the pure audit team view feedback resolver instead of adding more component-local branching.

Updated helper:

- `apps/web/src/views/plmAuditTeamViewManagementFeedback.ts`

New covered action kinds:

- `apply`
- `duplicate`
- `share`
- `rename`
- `transfer`

`PlmAuditView.vue` now routes those five handlers through the same resolver before mutation logic runs.

## Feedback Rules

### Apply

- no selected target -> explicit selection feedback
- archived target -> restore-first feedback
- other unavailable target -> generic apply denial

### Duplicate

- no selected target -> explicit selection feedback
- locked management target -> apply-first feedback
- unavailable target -> explicit duplicate denial

### Share

- no selected target -> explicit selection feedback
- locked management target -> apply-first feedback
- archived target -> restore-first feedback
- readonly target -> creator-only denial
- manageable but disabled target -> generic share denial

### Rename

- no selected target -> explicit selection feedback
- locked management target -> apply-first feedback
- archived target -> restore-first feedback
- readonly target -> creator-only denial
- missing name draft -> explicit name-required feedback
- remaining submit mismatch -> generic rename denial

### Transfer

- no selected target -> explicit selection feedback
- locked management target -> apply-first feedback
- archived target -> restore-first feedback
- readonly target -> creator-only denial
- missing target owner input -> explicit input-required feedback
- same owner input -> explicit no-op feedback
- remaining disabled state -> generic transfer denial

## Why This Shape

- Keeps `PlmAuditView.vue` from accumulating another set of bespoke action guards.
- Preserves one auditable precedence order for all audit team view management feedback.
- Continues the repo-wide effort to align direct handler behavior with disabled button semantics.
