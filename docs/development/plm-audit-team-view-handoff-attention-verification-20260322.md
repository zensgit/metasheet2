# PLM Audit Team-View Handoff Attention Verification

Date: 2026-03-22

## Scope

Verify that team-view handoff now clears stale source focus and local saved-view followup state before collaboration handoff UI takes over.

## Focused Checks

### Helper contract

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditSavedViewPromotion.spec.ts
```

Expected:

- `plmAuditSavedViewAttention.spec.ts` proves `buildPlmAuditTeamViewHandoffAttentionState(...)` clears source focus and local saved-view attention together
- saved-view promotion regressions remain green alongside the shared handoff helper

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` still compiles after both handoff entry points switch to the shared attention helper

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. `scene-context -> Save to team/default` now consumes stale local saved-view guidance before collaboration handoff becomes active
2. saved-view promotion uses the same handoff cleanup contract instead of a narrower saved-view-only cleanup step
3. team-view collaboration handoff becomes the only active transient guidance once the handoff succeeds
