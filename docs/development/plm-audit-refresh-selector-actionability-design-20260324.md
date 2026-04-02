# PLM Audit Refresh Selector Actionability Alignment Design

Date: 2026-03-24

## Problem

`PLM Audit` already trims local `Team views` UI state when a refresh removes rows entirely, but it still treated “row id still exists” as sufficient for keeping two local states:

- `auditTeamViewKey` (`Team views` selector)
- `auditTeamViewSelection` (batch lifecycle selection)

That left a real gap after refresh: the same view id could still exist, but no longer be apply-able or lifecycle-selectable under the current permissions. In that state:

- `Apply` still preferred the stale selector,
- generic canonical controls stayed locked against the drifted selector,
- batch selection could still show read-only rows as selected.

## Design

### 1. Export explicit actionability helpers from team-view management

`plmAuditTeamViewManagement.ts` now exposes:

- `canApplyPlmAuditTeamView(...)`
- `isSelectablePlmAuditTeamView(...)`

This keeps refresh-time trimming aligned with the same permission semantics already used to build row lifecycle actions.

### 2. Make refresh trimming actionability-aware

`trimPlmAuditExistingTeamViewUiState(...)` now accepts optional predicates:

- `isApplicableView`
- `isSelectableView`

The helper uses them to:

- clear `selectedTeamViewId` when the selected row still exists but is no longer apply-able,
- drop `selectedIds` for rows that still exist but are no longer lifecycle-selectable,
- preserve form drafts against the canonical management owner after the stale local selector is cleared.

### 3. Keep the watcher simple

`PlmAuditView.vue` still calls a single `trimAuditTeamViewSelection(...)` path from the `auditTeamViews` watcher. The only change is that the watcher now supplies the exported actionability helpers, instead of relying on “id exists” alone.

## Files

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditTeamViewManagement.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewManagement.ts)
- [plmAuditTeamViewOwnership.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewOwnership.ts)
- [plmAuditTeamViewOwnership.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewOwnership.spec.ts)

## Non-goals

- No backend or contract changes.
- No selector/actionability rewrite in other PLM panels.
- No changes to canonical ownership rules; this round only fixes refresh-time stale local UI residue.
