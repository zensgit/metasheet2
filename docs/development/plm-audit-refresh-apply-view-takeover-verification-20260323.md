# PLM Audit Refresh Apply-View Takeover Verification

## Scope

验证 `refreshAuditTeamViews()` 的 `apply-view` 本地 route 解析现在会像其他 takeovers 一样清掉 stale attention / notice / ownership。

## Checks

- refresh apply-view takeover focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewRouteTakeover.spec.ts tests/plmAuditTeamViewRouteState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditSceneContextTakeover.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewRouteTakeover.spec.ts tests/plmAuditTeamViewRouteState.spec.ts`
  - `4` 个文件，`30` 个测试通过
- `pnpm --filter @metasheet/web type-check`
  - 通过
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `48` 个文件，`307` 个测试通过

## Verified Outcome

- refresh-driven `apply-view` route coercion now clears stale attention / notice / ownership before local route apply
- shared-entry special-case takeover remains isolated from generic refresh apply-view takeover
- draft-owned single selection is still trimmed conservatively, while user multi-select remains intact
