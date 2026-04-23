# Approval Wave 2 WP3 slice 2 — 已读/未读 (验证记录)

- Date: 2026-04-23
- Branch: `codex/approval-wave2-wp3-approval-reads-20260423`

## TypeScript 编译

```bash
pnpm install --prefer-offline
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Both exited 0.

## 后端集成测试

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
  PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp3-reads.api.test.ts \
    tests/integration/approval-wp3-remind.api.test.ts \
    tests/integration/approval-wp3-pending-count.api.test.ts \
    tests/integration/approval-wp2-source-filter.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts --reporter=dot
```

结果：

```
 Test Files  7 passed (7)
      Tests  34 passed (34)
```

拆分：
- `approval-wp3-reads.api.test.ts` — 7 passed (新)
- `approval-wp3-remind.api.test.ts` — 6 passed (slice 1 回归)
- `approval-wp3-pending-count.api.test.ts` — 6 passed (slice 1 回归；响应新增 `unreadCount` 字段，旧 `count` 断言不受影响)
- `approval-wp2-source-filter.api.test.ts` — 5 passed
- `approval-pack1a-lifecycle.api.test.ts` — 3 passed
- `approval-wp1-any-mode.api.test.ts` — 3 passed
- `approval-wp1-parallel-gateway.api.test.ts` — 4 passed

## 前端单测

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/approvalCenterUnreadBadge.spec.ts \
  tests/approvalCenterRemindBadge.spec.ts \
  tests/approvalCenterSourceFilter.spec.ts --reporter=dot
```

结果：

```
 Test Files  3 passed (3)
      Tests  16 passed (16)
```

拆分：
- `approvalCenterUnreadBadge.spec.ts` — 6 passed (新)
- `approvalCenterRemindBadge.spec.ts` — 6 passed (mock 扩展为 `{ count, unreadCount }` 后原断言保留)
- `approvalCenterSourceFilter.spec.ts` — 4 passed

## 手动验证（dev 模式）

由于 USE_MOCK 分支让 `getPendingCount` 返回 `{ count: 3, unreadCount: 3 }`（sourceSystem=all），预期：
- 红点 `3`（与 USE_MOCK 列表长度一致）。
- 点击“全部标记已读” → toast `已标记 3 条为已读` → 红点隐藏（USE_MOCK 的 `markAllApprovalsRead` 返回 `markedCount`；但下一次 pending-count 仍是 mock fallback，所以红点会立刻刷新回 mock 值；这是开发模式的“看得到按钮生效”体验，不代表持久化语义）。
- 打开详情页 → 浏览器 Network 面板中出现 POST `/api/approvals/{id}/mark-read`（或 USE_MOCK 直接返回，不会发起真实请求）。

## 回归策略说明

- pending-count 响应是**additive**：`count` 字段语义未变；`unreadCount` 是新增。slice 1 的断言（只看 `count`）继续绿。
- slice 1 的前端红点 spec（`approvalCenterRemindBadge`) 仅更新了 `getPendingCount` mock 以同时提供 `unreadCount`——view 现在消费 `unreadCount`，但因 mock 里两值相等，断言的徽标数字不变。
- `approvalCenterSourceFilter.spec` 不 stub `approvals/api`，生产代码里 USE_MOCK 会返回 fallback 对象，view 可以成功 mount，原断言继续绿。（输出里有 `[Vue warn]: Failed to resolve component: el-badge / el-tooltip / el-icon`；这是 pre-existing 的 stub 覆盖缺失，不影响断言。）
