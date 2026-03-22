# PLM Audit Save-Current-View Focus Cleanup Verification

Date: 2026-03-22

## Scope

Verify that direct local saved-view creation now consumes stale source focus and local followup state instead of letting an older saved-view card remain highlighted.

## Focused Checks

### Helper contract

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts
```

Expected:

- `buildPlmAuditSavedViewStoreAttentionState(...)` clears source focus and local saved-view attention together
- existing handoff and followup reducer coverage remains green

### Type safety

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmAuditView.vue` still compiles after `storeAuditSavedView()` switches to the shared store-attention helper

### Full PLM frontend regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- no regressions across the broader PLM audit/workbench state-contract suite

## Behavioral Assertions

1. direct `Save current view` clears stale saved-view source focus
2. scene quick-save local-save still installs its new followup after the shared store cleanup runs
3. saved-view attention cleanup remains reducer-owned instead of spreading another ad hoc branch through `PlmAuditView.vue`
