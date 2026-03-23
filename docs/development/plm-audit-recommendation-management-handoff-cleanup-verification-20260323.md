# PLM Audit Recommendation Management Handoff Cleanup Verification

Date: 2026-03-23

## Scope

Verify that recommendation-driven management handoff now consumes stale saved-view/source attention before collaboration controls become the active transient guidance.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` still compiles after the recommendation handoff path switches to the shared handoff cleanup helper

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Expected:

- saved-view attention helper contract remains green
- collaboration contract tests remain green alongside the updated handoff call site

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. recommendation management handoff becomes the only active transient guidance
2. stale saved-view followup/highlight no longer survives the pivot into recommendation-driven management controls
3. the change is limited to call-site orchestration; route and collaboration contracts stay unchanged
