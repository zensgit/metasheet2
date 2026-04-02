# PLM Workbench Preset Single Lifecycle Audit Verification

## 变更文件

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`

## 回归点

- single preset `archive`
  - 返回成功
  - 写入 `plm-team-preset-batch` 审计
- single preset `restore`
  - 返回成功
  - 写入 `plm-team-preset-batch` 审计
- single preset `delete`
  - 返回成功
  - 写入 `plm-team-preset-batch` 审计
  - lookup 使用 `tenant_id + scope = team`

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

## 结果

- focused：`tests/unit/plm-workbench-routes.test.ts`，`1` 文件 / `33` 测试通过
- `pnpm build`
  - 通过
