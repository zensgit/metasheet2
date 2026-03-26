# PLM Workbench Approval History Route Unification Verification

## 变更文件

- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/routes/approval-history.ts`
- `packages/core-backend/tests/unit/approval-history-routing.test.ts`
- `apps/web/src/views/ApprovalInboxView.vue`

## 回归点

- 实际挂载顺序下，`/api/approvals/:id/history` 返回 paginated envelope，而不是旧的扁平 `{ data, total }`
- `page / pageSize` 会传进 SQL `LIMIT / OFFSET`
- 未认证请求命中 401
- `ApprovalInboxView` 能正确读取 `payload.data.items`

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/approval-history-routing.test.ts
pnpm build

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

## 结果

- backend focused：`1` 个文件，`2` 个测试通过
- backend build：通过
- frontend `type-check`：通过
