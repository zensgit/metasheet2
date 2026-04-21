# 审批 Wave 2 当前状态验证记录 2026-04-21

## 环境

- Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/approval-wave2-20260413`
- Branch: `codex/approval-wave2-20260413`
- Rebased base: `origin/main` @ `923b43ebd`
- PR: `#837`

## 代码复核范围

后端：

- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/routes/approvals.ts`

前端：

- `apps/web/src/types/approval.ts`
- `apps/web/src/views/approval/ApprovalDetailView.vue`
- `apps/web/src/views/approval/TemplateDetailView.vue`
- `apps/web/src/approvals/*`

## 命令与结果

### Worktree dependencies

```bash
pnpm install --frozen-lockfile
```

结果：通过。

备注：

- 首次补充 typecheck 时，隔离 worktree 缺少 `yjs` / `y-protocols` / `lib0` 依赖解析，导致前后端 typecheck 失败。
- 执行 `pnpm install --frozen-lockfile` 后依赖解析恢复。
- `pnpm install` 造成 `plugins/*/node_modules` 和 `tools/cli/node_modules` 的本地链接噪声；这些文件未纳入提交。

### 后端审批 targeted tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-template-routes.test.ts \
  tests/unit/approval-rbac-boundary.test.ts \
  --reporter=verbose
```

结果：

```text
Test Files  4 passed (4)
Tests       36 passed (36)
```

覆盖点：

- `ApprovalGraphExecutor` 初始节点解析、条件节点、空审批人 auto-approve、return visited-node 列表。
- `ApprovalProductService` revoke 策略、return 合法性、return 重新分配、all-mode 未全部处理时保持 pending。
- approval template routes 创建、更新、发布、列表和版本详情。
- approval RBAC 401/403/200 权限边界。

### 前端审批 targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/approval-center.spec.ts \
  tests/approval-e2e-lifecycle.spec.ts \
  tests/approval-e2e-permissions.spec.ts \
  --watch=false
```

结果：

```text
Test Files  3 passed (3)
Tests       85 passed (85)
```

备注：

- 测试期间 jsdom 输出既有 `el-icon` component resolution warning。
- 该 warning 没有导致测试失败。

覆盖点：

- Approval center 基础渲染和加载。
- 发起、详情、历史、模板中心、模板详情等前端生命周期。
- 权限态、return 按钮、return target 提交、approvalMode / emptyAssigneePolicy 展示、timeline metadata 展示。

### Diff 检查

```bash
git diff --check
```

结果：通过。

### Typecheck

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

结果：通过。

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

结果：通过。

## 当前结论

- 本地依赖环境已可运行审批 targeted tests，不再复现 2026-04-13 文档里的 dependency-missing 阻塞。
- 当前实现已经具备部分 Wave 2 节点级能力。
- 当前实现仍不是 true parallel / join DAG。
- #837 应更新为当前状态复核文档后再合入。

## 未验证项

- 未连接真实 staging 用户关闭 Wave 1 的 6 个真实环境验收项。
- 未做 PLM / 考勤真实链路联动。
- 未跑全仓 `pnpm test`。
- 未验证模板配置 UI 是否能完整 author `approvalMode` / `emptyAssigneePolicy` 并 round-trip 保存。
