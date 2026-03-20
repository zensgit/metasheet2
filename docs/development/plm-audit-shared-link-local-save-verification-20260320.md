# PLM Audit Shared-Link Local Save Verification

## Scope

Verify the new `Save as local view` action for `/plm/audit` shared team-view entry prompts.

## Checks

- Shared-link notice exposes actions in the expected order:
  - `Save as local view`
  - `Duplicate for my workflow`
  - `Set as default`
  - `Dismiss`
- Archived/default views still omit unavailable actions.
- Shared-link local saved-view names follow `<team view name> · Local view`.
- `PlmAuditView` handles the action by saving locally, clearing the share-entry prompt, and scrolling to the saved-views section.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmAuditTeamViewShareEntry.spec.ts tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Result

- Passed.
- Focused tests:
  - `tests/plmAuditTeamViewShareEntry.spec.ts`
  - `tests/plmWorkbenchViewState.spec.ts`
- Full frontend gates:
  - `49 files / 247 tests`
  - `type-check` passed
  - `lint` passed
  - `build` passed
