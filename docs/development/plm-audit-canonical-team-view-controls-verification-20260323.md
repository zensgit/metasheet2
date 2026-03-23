# PLM Audit Canonical Team View Controls Verification

Date: 2026-03-23

## Scope

Verify that selector-drifted team-view controls are gated and shared-entry duplicate payloads no longer read local draft names.

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
pnpm exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
```

Result:

- `2` files passed
- `16` tests passed

Covered assertions:

- selector drift between canonical route owner and local team-view selector locks generic management actions
- shared-entry duplicate ignores selector-local draft names
- shared-entry canonical target resolution still holds

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `44` files passed
- `272` tests passed

- no regressions expected across existing PLM audit/workbench route-state and transient-attention coverage
