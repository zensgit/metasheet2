# PLM Audit Shared-Entry Takeover Precedence Verification

Date: 2026-03-23

## Scope

Verify that shared-entry notice actions stay pinned to the canonical entry target and that source-aware collaboration owners consume active shared-entry ownership instead of coexisting with it.

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
pnpm exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/usePlmCollaborativePermissions.spec.ts
```

Result:

- `3` files passed
- `48` tests passed

Covered assertions:

- shared-entry actions resolve against the canonical entry target before falling back to the local selector
- recommendation/source-aware collaboration owners take over active shared-entry ownership
- target-based share/duplicate/set-default permissions stay available without relying on the local selector

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `267` tests passed
