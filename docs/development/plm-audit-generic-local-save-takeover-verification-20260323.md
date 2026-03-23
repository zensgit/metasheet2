# PLM Audit Generic Local-Save Takeover Verification

## Scope

验证 generic `Save current view` 在保存本地 saved view 后，会像其他 saved-view takeover 一样接管旧的 collaboration owner，而不是留下旧 draft / followup。

## Checks

- collaboration helper focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
  - `1` 个文件，`42` 个测试通过
- `pnpm --filter @metasheet/web type-check`
  - 通过
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` 个文件，`301` 个测试通过

## Verified Outcome

- generic `Save current view` 保存成功后会清掉旧 collaboration draft / followup
- draft 自动装出来的单行 selection 会和旧 collaboration owner 一起被回收
- source-aware local save 路径保持不变，没有回归到 generic store 语义
