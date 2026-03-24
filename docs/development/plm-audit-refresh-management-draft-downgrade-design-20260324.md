# PLM Audit Refresh Management Draft Downgrade Design

Date: 2026-03-24

## Problem

The previous refresh cleanup aligned stale local selectors and batch selection with actionability, but one management-owned residue still remained:

- a team view could survive refresh with the same id,
- still be apply-able,
- but lose management permission,
- while the old `auditTeamViewNameOwnerId` binding kept treating the name input as a rename draft.

That left the UI in an inconsistent middle state: the text draft stayed bound to a team-view owner that was no longer manageable.

## Design

### 1. Separate name preservation from owner binding preservation

`trimPlmAuditExistingTeamViewUiState(...)` now distinguishes between:

- preserving the visible name text, and
- preserving the management-owner binding behind that text.

When a refresh leaves the same team view id present but non-manageable:

- keep `draftTeamViewName`,
- clear `draftTeamViewNameOwnerId`,
- clear `draftOwnerUserId`.

This downgrades the stale management draft into a safe create-mode draft instead of dropping the user’s text.

### 2. Keep local-selector-owned drafts intact

If the name draft is still owned by a surviving local selector target, the binding is preserved even when a different canonical owner disappears. This avoids regressing the already-locked “local selector still valid” path.

### 3. Reuse explicit manageability helpers

`plmAuditTeamViewManagement.ts` now exports `canManagePlmAuditTeamView(...)`, and `PlmAuditView.vue` passes that into the existing refresh trim path together with:

- `canApplyPlmAuditTeamView(...)`
- `isSelectablePlmAuditTeamView(...)`

No new watcher branch was added; the existing refresh trim remains the only orchestration path.

## Files

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditTeamViewManagement.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewManagement.ts)
- [plmAuditTeamViewOwnership.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewOwnership.ts)
- [plmAuditTeamViewOwnership.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewOwnership.spec.ts)

## Non-goals

- No changes to backend permissions.
- No broader rewrite of `usePlmCollaborativePermissions`.
- No change to create-mode draft preservation.
