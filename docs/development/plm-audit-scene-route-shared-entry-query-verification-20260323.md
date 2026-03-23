# PLM Audit Scene Route Shared-Entry Query Verification

## Scope

验证 scene route takeovers 现在在清掉 shared-entry owner 的同时，也会消费 URL 上的 `auditEntry=share` marker。

## Checks

- scene takeover focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditSceneContextTakeover.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditSceneContextTakeover.spec.ts`
  - `1` 个文件，`3` 个测试通过
- `pnpm --filter @metasheet/web type-check`
  - 通过
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `47` 个文件，`305` 个测试通过

## Verified Outcome

- scene route takeovers now emit explicit shared-entry query consumption when they clear shared-entry owner
- scene route sync no longer relies only on stable route-state diffs to remove transient `auditEntry=share`
- stale shared-entry markers no longer survive scene-owned route pivots and rehydrate old notices after refresh
