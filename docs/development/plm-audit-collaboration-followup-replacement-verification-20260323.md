# PLM Audit Collaboration Followup Replacement Verification

Date: 2026-03-23

## Scope

Verify that a new collaboration `share` followup now replaces any older collaboration draft instead of coexisting with it.

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
pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
```

Result:

- `2` files passed
- `46` tests passed

Covered assertions:

- a collaboration share followup replaces an existing draft on the same team view
- a collaboration share followup replaces an existing draft on a different team view
- shared-entry regressions still hold alongside the new collaboration replacement rule

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `268` tests passed

- no regressions expected across existing PLM audit/workbench route-state and transient-attention coverage
