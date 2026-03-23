# PLM Audit Shared-Entry Local Save State Verification

Date: 2026-03-23

## Scope

Verify that shared-entry local saves now persist canonical route state instead of selector-mutated local state.

## Type Safety

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Focused Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
```

Result:

- `2` files passed
- `19` tests passed

Covered assertions:

- shared-entry local-save source still resolves from canonical route ownership
- shared-entry local saves persist canonical route state
- scene-context local saves keep persisting the current local state

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `269` tests passed

- no regressions expected across existing PLM audit/workbench route-state and transient-attention coverage
