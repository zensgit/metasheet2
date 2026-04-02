# PLM Workbench Audit Share Entry Runtime Verification

## Scope

Verified that stale `auditTeamViewShareEntry` state is now normalized away when its backing team view is missing from the current audit team-view catalog.

## Focused Checks

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditSavedViewShareFollowup.spec.ts
```

Result:

- `2` files passed
- `29` tests passed

Coverage locked by the new assertions:

- runtime share-entry state remains unchanged while the target is still present
- runtime share-entry state clears when the target no longer exists

## Type Check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Outcome

`auditTeamViewShareEntry` no longer lingers invisibly in memory after its target disappears, and local-save followup source detection now consumes the normalized runtime state.
