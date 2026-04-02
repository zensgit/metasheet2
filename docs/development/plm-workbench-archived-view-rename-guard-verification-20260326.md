# PLM Workbench Archived View Rename Guard Verification

## 变更文件

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`

## 回归点

- owner 正常的 archived `team view` 仍然不能重命名
- 返回 `409 Archived PLM team views cannot be renamed`
- 未归档 view 的 rename 正常路径保持不变

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts
pnpm build
```

## 结果

- backend focused：`1` 个文件，`34` 个测试通过
- backend build：通过
