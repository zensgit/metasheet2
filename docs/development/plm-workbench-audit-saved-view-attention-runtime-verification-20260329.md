# PLM Workbench Audit Saved-View Attention Runtime Verification

## Scope

Verified the runtime normalization for `focusedSavedViewId` so stale saved-view attention no longer lingers after the backing saved view leaves the current local catalog.

## Focused Checks

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditSceneContextTakeover.spec.ts
```

Result:

- `3` files passed
- `40` tests passed

Assertions now lock:

- stale saved-view focus clears when the saved view is missing
- valid saved-view focus remains intact
- share-entry runtime state also normalizes against the current team-view catalog
- scene-context takeovers clear managed form drafts but preserve create-mode drafts

## Type Check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Full Regression

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `64` files passed
- `554` tests passed

## Outcome

Transient saved-view attention now follows the same runtime-normalized contract as the rest of the audit followup and ownership state.
