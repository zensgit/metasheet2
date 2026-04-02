# PLM Audit Team View Save Attention Cleanup Verification

Date: 2026-03-23

## Scope

Verify that generic `Save to team` persistence now consumes stale source attention and local saved-view followups before the new durable team view takes over.

## Checks

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- the new persisted-team-view attention helper compiles cleanly
- `PlmAuditView.vue` type-checks after the generic save-to-team path switches to shared attention cleanup

### Focused regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts
```

Expected:

- the saved-view attention suite proves persisted team-view takeover clears recommendation/saved-view source attention and local followup state
- existing attention-helper contracts remain green alongside the new helper

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the PLM audit/workbench state-closure suite

## Behavioral Assertions

1. `recommendation -> type team-view name -> Save to team` ends with only the new team-view management focus active
2. `shared-entry/local followup -> Save to team` no longer keeps the old saved-view local followup visible
3. scene-driven save-to-team flows remain compatible because they still install their own collaboration handoff after the generic persistence step
