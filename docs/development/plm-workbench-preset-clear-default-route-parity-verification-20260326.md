# PLM Workbench Preset Clear-Default Route Parity Verification

## 变更文件

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`

## 回归点

- archived `team preset` 走 `/api/plm-workbench/filter-presets/team/:id/default`
  - 返回 `409`
  - error 包含 `Archived PLM team presets cannot clear the default`
- route lookup 会带上
  - `tenant_id = current tenant`
  - `scope = team`

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

## 结果

- focused：`tests/unit/plm-workbench-routes.test.ts`，`1` 文件 / `31` 测试通过
- `pnpm build`
  - 通过
