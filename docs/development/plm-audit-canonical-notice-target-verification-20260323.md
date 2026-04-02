# PLM Audit Canonical Notice Target Verification

Date: 2026-03-23

## Scope

Verify that collaboration and shared-entry notices stay anchored to their canonical target team view instead of disappearing when only the local selector changes.

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
pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/usePlmCollaborativePermissions.spec.ts
```

Result:

- `3` files passed
- `47` tests passed

Covered assertions:

- collaboration draft targets can be resolved independently from the local selector
- shared-entry targets can be resolved independently from the local selector
- target-based share/duplicate/set-default permissions can be derived without relying on the current selector

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `266` tests passed
