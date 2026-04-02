# PLM Workbench Preset Set-Default Route Parity Verification

## 变更文件

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`

## 回归点

- `POST /api/plm-workbench/filter-presets/team/:id/default`
  - owner 可正常把 team preset 设为默认
  - lookup 会带上 `tenant_id = current tenant`
  - lookup 会带上 `scope = team`

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

## 结果

- focused：`tests/unit/plm-workbench-routes.test.ts`，`1` 文件 / `32` 测试通过
- `pnpm build`
  - 通过
