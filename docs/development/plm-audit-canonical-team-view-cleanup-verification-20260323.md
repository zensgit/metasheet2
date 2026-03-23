# PLM Audit Canonical Team View Cleanup Verification

Date: 2026-03-23

## Scope

验证 `PLM Audit` 里的 `shared-entry` / `collaboration draft` / `collaboration followup` 生命周期是否已经改为由 canonical route 驱动，而不是由未提交的本地下拉选择驱动。

## Focused Checks

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

结果：

- `2` 个文件通过
- `39` 个测试通过

新增断言覆盖：

- `shared-entry` 只在 canonical `teamViewId` 仍匹配时保留
- `collaboration draft` 只在 canonical `teamViewId` 仍匹配时保留

## Type Check

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

## Full Regression

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `43` 个文件通过
- `257` 个测试通过

## Manual Behavior To Spot-Check

1. 打开 `?teamViewId=A&auditEntry=share`
2. 只切换下拉到 `B`，不点 `Apply`
3. 确认 share-entry notice 只是因当前选中项不同而隐藏，不会被销毁
4. 切回 `A` 后，notice 应可再次出现
5. 对 collaboration draft / followup 重复同样检查
