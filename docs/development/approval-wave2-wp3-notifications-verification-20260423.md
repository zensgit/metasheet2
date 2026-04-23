# Approval Wave 2 WP3 slice 1 — 催办 + 待办红点 (验证记录)

- Date: 2026-04-23
- Branch: `codex/approval-wave2-wp3-notifications-20260423`
- Base: `origin/main@8d2d3e1b0` after final rebase
- Related dev MD: `docs/development/approval-wave2-wp3-notifications-development-20260423.md`

## 验证命令与结果

所有命令都在 worktree 根目录 `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/wp3-notifications` 执行。

### 1) 依赖安装

```bash
pnpm install --prefer-offline
```

完成，无报错。

### 2) Typecheck

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

两者均无输出、退出码 0。

### 3) WP3 新增集成测试

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp3-remind.api.test.ts \
    tests/integration/approval-wp3-pending-count.api.test.ts --reporter=dot
```

```
Test Files  2 passed (2)
     Tests  12 passed (12)
```

- `approval-wp3-remind.api.test.ts` — 6 case pass (happy path / 429 / 403 / reviewer 允许 / 404 / 400 非 pending)
- `approval-wp3-pending-count.api.test.ts` — 6 case pass (all / platform / plm / 默认值 / 400 / 过滤 inactive)

### 4) 回归基线

```bash
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp2-source-filter.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-wp1-parallel-gateway.api.test.ts --reporter=dot
```

```
Test Files  4 passed (4)
     Tests  15 passed (15)
```

各基线套件计数：
- `approval-wp2-source-filter.api.test.ts` — 7 pass
- `approval-pack1a-lifecycle.api.test.ts` — 3 pass
- `approval-wp1-any-mode.api.test.ts` — 1 pass
- `approval-wp1-parallel-gateway.api.test.ts` — 4 pass

### 5) 前端 spec

```bash
pnpm --filter @metasheet/web exec vitest run tests/approvalCenterRemindBadge.spec.ts --reporter=dot
```

```
Test Files  1 passed (1)
     Tests  6 passed (6)
```

覆盖：
- `ApprovalCenterView` — pending-count=5 时渲染 `data-testid="approval-pending-badge"` 且值=5
- `ApprovalCenterView` — pending-count=0 时 badge 隐藏
- `ApprovalDetailView` — requester 能看到 `催一下` 按钮
- `ApprovalDetailView` — 点击 `催一下` 触发 `remindApproval('apv_remind_target')` 并弹 success toast
- `ApprovalDetailView` — 429 响应时 toast 文案包含“已在” + “催办过”
- `ApprovalDetailView` — 非 requester 时 `催一下` 按钮不渲染

并行回归：`tests/approvalCenterSourceFilter.spec.ts` 仍 4/4 pass，确认未破坏 WP2 的 source filter spec。

## 基线参考

- `main` 基线 HEAD: `d1f35edf6`（`test(ops): add stacked PR readiness guard (#1103)`）。
- `approval-center.spec.ts` 在 baseline 即有 5 个 failing（`refreshApprovalAccess` 相关），本 slice 未引入新 regression（`git stash` 复现确认）。

## 不纳入本 slice 的验证

- 未做真实通知通道 E2E（外部 IM / 邮件 / push）。
- 未做 WebSocket 多端红点实时推送验证；红点刷新目前是拉式（mount + tab switch）。
- PLM 源的催办仅有本地记录覆盖（`bridged:false`），未对 PLM adapter 做集成调用（phase 1 未引入推送通道）。

## Rebase Verification - 2026-04-23

- Rebased `codex/approval-wave2-wp3-notifications-20260423` onto `origin/main@76ddfeacd`.
- Rebased HEAD: `cc17db0d5`.
- Dirty generated dependency entries under `plugins/` and `tools/` were cleared before rebase; no business-file conflicts occurred.
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false`: pass.
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`: pass.
- WP3 integration tests: 2 files / 12 tests passed.
- WP2 + Pack 1A + WP1 regression integration tests: 4 files / 15 tests passed.
- Frontend `approvalCenterRemindBadge` + `approvalCenterSourceFilter`: 2 files / 10 tests passed.
- Integration startup still logs pre-existing degraded-mode messages for optional workflow/event/automation tables in this local DB, but all targeted API assertions pass.

## Final Rebase - 2026-04-23

- Rebased again onto `origin/main@8d2d3e1b0` after DingTalk P4 env/product-gate follow-ups merged.
- Final HEAD: `8b3421486`.
- No conflicts and no touched-file overlap with the new DingTalk P4 commits.
- Final quick recheck: `git diff --check` passed; frontend `approvalCenterRemindBadge` + `approvalCenterSourceFilter` passed again, 10/10.
