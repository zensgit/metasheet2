# PLM Audit Collaboration Followup Dismiss Focus Cleanup Verification

Date: 2026-03-23

## Scope

Verify that clearing a collaboration followup now clears all transient attention instead of leaving stale management focus behind.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` compiles after collaboration-followup cleanup switches to the dedicated helper
- the new helper export integrates cleanly with the existing attention module

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- the saved-view attention suite proves collaboration-followup cleanup clears management/source/saved-view focus together
- collaboration helper tests remain green alongside the updated followup-clear path

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. `recommendation -> set-default -> Done` no longer leaves the old lifecycle row highlighted
2. route-driven followup cleanup and explicit dismissal now clear the same transient attention
3. source-aware `focus-source` behavior remains intact while followup cleanup becomes stricter
