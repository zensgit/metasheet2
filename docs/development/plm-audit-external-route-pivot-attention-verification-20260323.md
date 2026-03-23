# PLM Audit External Route Pivot Attention Verification

Date: 2026-03-23

## Scope

Verify that external `/plm/audit` route pivots now clear transient attention, while local route syncs keep their existing semantics.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` compiles after the route watcher starts distinguishing local syncs from external pivots
- the shared route-pivot attention helper integrates cleanly with the attention module

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- the saved-view attention suite proves route pivots clear all transient focus plus local saved-view attention
- collaboration helper tests remain green while the watcher/local pivot code shares the new helper

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the PLM audit/workbench state-contract suite

## Behavioral Assertions

1. browser back/forward no longer leaves a stale recommendation card or lifecycle row highlighted on a different audit route
2. local filter/pagination actions still clear transient attention exactly once
3. incompatible collaboration followups continue to clear through their own compatibility rules
