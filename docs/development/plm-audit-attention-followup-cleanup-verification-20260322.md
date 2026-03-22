# PLM Audit Attention And Followup Cleanup Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify the PLM Audit frontend cleanup around:

- saved-view attention residue
- collaboration followup residue
- recommendation focus residue

## Automated Verification

### 1. Type check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

### 2. Targeted PLM frontend regression suite

Command:

```bash
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` test files passed
- `235` tests passed

## Added Coverage

### 1. Saved-view attention reducer

`apps/web/tests/plmAuditSavedViewAttention.spec.ts`

Covers:

- clearing saved-view local followup and focus on `apply`
- clearing saved-view local followup and focus on saved-view context actions
- clearing saved-view local followup and focus on `reset-filters`
- clearing only the deleted saved-view attention target

### 2. Collaboration followup lifecycle helpers

`apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Covers:

- route compatibility for share followups
- route compatibility for default-promotion followups
- pruning deleted `sourceSavedViewId` from collaboration drafts
- pruning deleted `sourceSavedViewId` from collaboration followups

### 3. Recommendation focus catalog cleanup

`apps/web/tests/plmAuditTeamViewCatalog.spec.ts`

Covers:

- keeping a focused recommendation id only while the card is still visible
- consuming the focused recommendation id when the current recommendation filter hides the card

## Verified User Paths

The following paths are now covered by code + regression checks:

1. `focus-source -> Apply saved view`
2. `focus-source -> saved-view context quick action`
3. `focus-source -> Reset filters`
4. `saved-view promotion -> delete source saved view`
5. `default-promotion followup -> route pivot away from default-change logs`
6. `recommendation focus -> recommendation filter hides the card`

## Residual Risk

There is still no view-level browser test around the exact rendered followup/focus dismissal sequence inside `PlmAuditView.vue`.

Current confidence comes from:

- pure helper coverage
- targeted PLM regression coverage
- `vue-tsc` passing on the integrated view code
