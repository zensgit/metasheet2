# PLM Audit Saved-View Shared-Entry Takeover Verification

## Scope

验证 saved-view apply/context takeovers 现在会消费 shared-entry owner，而不是在 canonical route state 不变化时留下 stale `auditEntry=share` marker 和 share-entry notice。

## Checks

- shared-entry helper focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts`
  - `1` 个文件，`16` 个测试通过
- `pnpm --filter @metasheet/web type-check`
  - 通过
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` 个文件，`302` 个测试通过

## Verified Outcome

- saved-view takeover now consumes active shared-entry owner locally
- saved-view apply/context route sync now consumes `auditEntry=share` even when canonical route state is unchanged
- shared-entry notice and URL marker no longer survive a saved-view takeover
