# PLM Audit Source Share Management Focus Cleanup Verification

Date: 2026-03-23

## Scope

Verify that source-aware `share` followups clear stale lifecycle-management focus in addition to existing source/local attention cleanup.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` still compiles after sourceful `share` switches to the stricter cleanup helper
- `plmAuditSavedViewAttention.ts` exports the new helper without type regressions

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- the new pure helper clears management, recommendation, and saved-view focus together
- collaboration followup tests remain green with the updated source-aware `share` wiring

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. source-aware `share` no longer leaves an old lifecycle row highlighted
2. source-aware `set-default` still preserves the active management target it immediately installs
3. saved-view followup/source focus cleanup remains intact while the management-focus rule becomes stricter for `share`
