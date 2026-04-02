# PLM Workbench Archived Preset Transfer Guard Verification

## 变更文件

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`

## 回归点

- archived `team preset` 走 `/api/plm-workbench/filter-presets/team/:id/transfer`
  - 返回 `409`
  - error 包含 `Archived PLM team presets cannot be transferred`

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

## 结果

- focused：`tests/unit/plm-workbench-routes.test.ts`，`1` 文件 / `30` 测试通过
- `pnpm build`：
  - 未通过
  - 阻塞于既有类型错误：`src/routes/plm-workbench.ts:515`、`src/routes/plm-workbench.ts:550`
  - 报错内容是 `last_default_set_at` 的泛型返回类型不兼容，本次改动未触及该段逻辑
