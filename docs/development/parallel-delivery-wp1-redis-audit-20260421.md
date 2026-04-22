# 并行交付汇总 — Wave 2 WP1 或签 / Redis 适配器 / Audit UI

Date: 2026-04-21
Status: 3 条通道已 rebase 到 `origin/main@c4093dcb8`、重跑验收全绿；未 push，待人工复核后开 PR（Redis PR 另需 live-Redis smoke 作为人工门禁）。

---

## 1. 总览

本轮按"零文件交叉 + 独立 worktree + 按泳道纪律"的方式并行交付 3 条 PR-ready 分支：

| 通道 | 分支 | 原提交 | Rebase 后 HEAD | Worktree | 价值定位 |
|---|---|---|---|---|---|
| 1 | `codex/approval-wave2-wp1-runtime-202605` | `9afdf75ff` | `02dcceda2` | `.worktrees/wp1` | 补齐飞书审批 9 项空白中的或签 |
| 2 | `codex/collab-infra-redis-runtime-202605` | `24657596f` | `4565e44a6` | `.worktrees/redis` | 发布前硬化：水平扩展必做的两项基础设施 |
| 3 | `codex/audit-log-ui-frontend-202605` | `3619f51ca` | `be2553690` | `.worktrees/audit-ui` | 运营闭环：后端已就绪，前端点亮 |

共同基线：3 条分支原自 `origin/main@0756ff61d` 切出，2026-04-21 已全部 rebase 到最新 `origin/main@c4093dcb8`（+21 commits 上游：公 POC preflight、dingtalk #952/#954/#955/#964/#965、automation/chart/dashboard route 修复、field validation wiring #944 gap #3 等）。三条分支业务文件与那 21 个 commit **零交叉**，rebase 均为纯 fast-forward，无冲突；业务 diff 行数在 rebase 前后完全一致。

---

## 2. 通道一：审批 Wave 2 WP1 或签（any-mode）

### 范围与取舍

Pack 1A 已交付 `approvalMode='all'` 会签、return 到指定节点、空审批人自动通过；本轮补齐 `approvalMode='any'` 或签。并行分支（parallel gateway）本轮延后，因为它需要将 `ApprovalGraphResolution` 从单 `currentNodeKey` 改为 fork 列表，对数据结构与前端时间线渲染都是一次较大改动，适合独立 slice。

### 文件清单（9 文件，+1032 / −22）

| 层 | 文件 | 变更 |
|---|---|---|
| Runtime | `packages/core-backend/src/services/ApprovalGraphExecutor.ts` | +43 · resolution 暴露 `aggregateMode` + `aggregateComplete` |
| Runtime | `packages/core-backend/src/services/ApprovalProductService.ts` | +69 · 路由层从 DB-权威 active assignments 派生 `aggregateCancelled`，正确覆盖 transfer 后的兄弟受让人 |
| Contracts | `packages/openapi/src/base.yml` | +7 · metadata 约定 `aggregateMode` / `aggregateCancelledBy` / `aggregateCancelledAt` |
| Integration tests | `packages/core-backend/tests/integration/approval-wp1-any-mode.api.test.ts` | +499（新增） |
| Unit tests | `packages/core-backend/tests/unit/approval-graph-executor.test.ts` | +36 |
| Frontend | `apps/web/src/views/approval/ApprovalDetailView.vue` | +36 · 或签徽章 + 被覆盖决策的柔和说明 |
| Frontend | `apps/web/src/approvals/api.ts` | +83 · mock 新增或签生命周期 fixture |
| Docs | `docs/development/approval-wave2-wp1-runtime-development-20260420.md` | 175 行 |
| Docs | `docs/development/approval-wave2-wp1-runtime-verification-20260420.md` | 106 行 |

### 关键设计决策

1. `aggregateCancelled` 在路由层派生，不在 executor：受让人可被 transfer 重新分配，执行器只看模板定义无法穷举真实 active assignments。路由层直接读 `approval_assignments WHERE instance_id=? AND node_key=? AND is_active=TRUE` 得到权威列表，首胜者 approve 后批量 deactivate 其余。
2. 兄弟 approver 复审沿用既有 `403 APPROVAL_ASSIGNMENT_REQUIRED`：不引入新错误码，前端无需适配。
3. `aggregateComplete=true` 的语义不变：`all` 模式下全部审批人通过 / `any` 模式下首胜者通过，前端可统一消费。

### 测试结果

- 新集成：`approval-wp1-any-mode.api.test.ts` 1/1 通过
- Pack 1A 回归：`approval-pack1a-lifecycle.api.test.ts` 3/3 通过
- 执行器单元：`approval-graph-executor.test.ts` 8/8 通过（含 1 新用例）
- core-backend 全量 unit 套件：113 文件 / 1454 测试全通过
- 前端 approval 相关规格：46/46 通过
- `tsc --noEmit` + `vue-tsc --noEmit`：无诊断

---

## 3. 通道二：Token Bucket + CircuitBreaker Redis 适配器

### 范围与取舍

下一阶段 backlog 原本列出"自动化规则 / 限流器 → Redis"，侦察后确认：

- 中间件限流（`middleware/rate-limiter.ts`）已有 `RedisRateLimitStore`，不需重做
- Webhook 投递已 PG 持久化，不需迁移
- 真正的空白是：Token Bucket 限流器（`integration/rate-limiting/token-bucket.ts` 纯内存）+ Circuit Breaker（`gateway/CircuitBreaker.ts` 纯内存）

自动化调度器（AutomationScheduler）本轮延后：多进程并发时需要队列或 leader election，不是薄适配层能解决。

### 文件清单（12 文件，+2218 / −4）

| 层 | 文件 | 变更 |
|---|---|---|
| Runtime (seam) | `packages/core-backend/src/integration/rate-limiting/token-bucket.ts` | +51 · 接受可选 `store?: TokenBucketStore`，新增 `consumeAsync()` |
| Runtime (seam) | `packages/core-backend/src/gateway/CircuitBreaker.ts` | +75 · 接受可选 `CircuitBreakerRuntimeOptions`，新增 `refreshSharedState()` / `reportToStore()` |
| Contracts | `packages/core-backend/src/integration/rate-limiting/token-bucket-store.ts` | +103 · 接口 + `MemoryTokenBucketStore` |
| Contracts | `packages/core-backend/src/gateway/circuit-breaker-store.ts` | +251 · 接口 + `MemoryCircuitBreakerStore` |
| Implementation | `packages/core-backend/src/integration/rate-limiting/redis-token-bucket-store.ts` | +270 · Lua 原子消费 + 纯 JS 孪生逻辑 |
| Implementation | `packages/core-backend/src/gateway/redis-circuit-breaker-store.ts` | +569 · 4 段 Lua 脚本 + 纯 JS 孪生 + 纯读 `getSnapshot` |
| Unit tests | `packages/core-backend/tests/unit/redis-token-bucket-store.test.ts` | +253 · 11 个用例 |
| Unit tests | `packages/core-backend/tests/unit/redis-circuit-breaker-store.test.ts` | +358 · 14 个用例 |
| Barrel | `packages/core-backend/src/integration/rate-limiting/index.ts` | +23 re-export |
| Barrel | `packages/core-backend/src/gateway/index.ts` | +34 re-export |
| Docs | 开发 / 验证 MD | 165 + 70 行 |

### 关键设计决策

1. 适配层对调用方零侵入：所有构造函数新增参数皆为可选，现有代码默认仍走内存实现，生产切 Redis 只需一处 `new TokenBucketRateLimiter(opts, { store: new RedisTokenBucketStore() })`。
2. Lua 原子性 + 纯 JS 孪生：所有 Redis Lua 逻辑都在同一文件导出一个纯 JS 等价函数，供 CI 上无 Redis 环境时的单测直接验证脚本行为；生产运行时走 `EVALSHA` + `SCRIPT LOAD` fallback。
3. `getSnapshot` 保持纯读：advisor 审阅中发现早期草稿让 `getSnapshot` 调用 `checkAndUpdate` 会带硬编码阈值回写状态，已改为纯 `HMGET` 读取；测试专门断言连续 5 次 `getSnapshot` 不裁剪事件窗口。
4. APIGateway 的 CircuitBreaker 接线延后：`APIGateway` 内部 `new CircuitBreaker(config)` 的 map 未改，属于 business wiring，不在本轮基础设施范围。

### 测试结果

- 新适配器：25/25 通过（11 + 14）
- 既有 `rate-limiter.test.ts`：15/15 通过
- 既有 `rate-limiting.test.ts`：36/36 通过
- `tsc --noEmit`：零诊断
- Redis 未启动时测试仍 100% 通过（靠纯 JS 孪生）

---

## 4. 通道三：审计日志 UI 对接 `/api/audit-logs`

### 范围与取舍

侦察发现 `apps/web/src/views/AdminAuditView.vue` 551 行已经存在，但调用的 `/api/admin/audit-activity` / `/api/admin/session-revocations` 后端从未存在；与此同时 `/api/audit-logs`（RBAC `audit:read`）功能完整（筛选 + 分页 + CSV/NDJSON 导出）。

最小可上线路径：改 URL + 改响应形状 + 前端降级会话撤销面板。不新增后端端点。

### 文件清单（4 文件，+635 / −174）

| 层 | 文件 | 变更 |
|---|---|---|
| Frontend | `apps/web/src/views/AdminAuditView.vue` | +97 / −223 · 全面改走 `/api/audit-logs` |
| Frontend tests | `apps/web/tests/adminAuditView.spec.ts` | +243（新增） |
| Docs | 开发 / 验证 MD | 167 + 76 行 |

### 关键设计决策

1. CSV 导出走 `apiFetch → blob → anchor`，不用 `window.open`：裸 anchor 会丢失 `apiFetch` 注入的 `Authorization: Bearer` 头，对 RBAC 保护的路由会 401（与 `useAttendanceAdminAuditLogs.ts` 一致）。
2. 关键字搜索拆成 `actor_id` + `resource_id` 两个精确输入：不做"看起来像 id"的启发式路由，避免正则脆弱。
3. 日期补时间分量：后端拒绝裸 `YYYY-MM-DD`，前端自动补 `T00:00:00.000Z` / `T23:59:59.999Z`。
4. 会话撤销面板降级占位符：不发起 404 请求，面板渲染为"待后续版本接入"虚线框，待独立后端就位后再启用。
5. `id` 类型对齐 uuid：`operation_audit_logs.id` 是 uuid，前端 `AdminAuditLogItem.id` 相应声明为 string。

### 测试结果

- 新规格 `adminAuditView.spec.ts`：5/5 通过（mount / 空态 / ISO 时间过滤 / 分页 / CSV 导出）
- 邻居 `directoryManagementView.spec.ts` 回归：33/33 通过
- `vue-tsc --noEmit`：无诊断

---

## 5. 并行交付纪律

本轮严格遵循仓库既有 4 泳道 + 独立 worktree + baseline-first 纪律：

| 纪律点 | 实施方式 |
|---|---|
| 分支命名 | `codex/<theme>-<lane>-YYYYMM`，与现有约定一致 |
| 切分基线 | 3 条分支均自 `origin/main@0756ff61d` 切出，无跨主题污染 |
| 独立 worktree | `.worktrees/wp1` / `.worktrees/redis` / `.worktrees/audit-ui` 彼此隔离 |
| 文件零交叉 | 3 条分支真实 diff 无重叠文件 |
| 提交原子 | 每条分支一个 commit；未 push；未 amend |
| 文档成对 | 每条分支各自产出 development + verification MD，共 6 个 |
| 测试门禁 | 每条分支在本地本 worktree 内跑对应验证套件，全绿方提交 |

---

## 6. 推送与合并建议

### 6.1 推送前 rebase — 已完成（2026-04-21）

三条分支已在 2026-04-21 完成 rebase 到 `origin/main@c4093dcb8`，过程如下：

```bash
# 1. 清理 pnpm install 在 worktree 留下的 plugins/*/node_modules + tools/cli/node_modules 脏改动
for d in .worktrees/wp1 .worktrees/redis .worktrees/audit-ui; do
  git -C "$d" checkout -- plugins/ tools/
done

# 2. Rebase — 均成功，无冲突
for d in .worktrees/wp1 .worktrees/redis .worktrees/audit-ui; do
  git -C "$d" fetch origin main
  git -C "$d" rebase origin/main
done
```

结果记录于各 verification MD 的 "Rebase verification — 2026-04-21" 段落。

### 6.2 推送与 PR 顺序

| 顺序 | 分支 | 理由 |
|---|---|---|
| 1 | `codex/audit-log-ui-frontend-202605` | 纯前端、零基础设施风险，充当 CI 热身 |
| 2 | `codex/approval-wave2-wp1-runtime-202605` | 产品价值直接、覆盖面窄、测试最充分 |
| 3 | `codex/collab-infra-redis-runtime-202605` | 基础设施最后合，避免与其他 infra PR 争夺 reviewer 注意力 |

3 条 PR 彼此独立可任意顺序合并；上述顺序只是 PR-open 顺序建议。

### 6.3 合并后的落地清单

- WP1：在测试环境创建一个 `approvalMode='any'` 模板，跑完整生命周期，确认历史时间线徽章 + DB 中 `metadata.aggregateCancelledBy` 写入正确
- Redis：后续切换 `TokenBucketRateLimiter` / `CircuitBreaker` 的生产实例时注入对应 Redis store；准备一个 `REDIS_URL` 环境变量检查的文档章节
- Audit UI：确认平台管理员有 `audit:read` 权限；验证 CSV 导出在 Safari / Chrome 都触发下载（blob 方案一般没问题）

---

## 7. 下一轮并行候选

本轮完成后，下一轮仍可维持零文件交叉的 3 条并行：

| 候选 | 范围 | 前置条件 |
|---|---|---|
| WP1 并行分支（parallel gateway） | 扩展 `ApprovalGraphResolution` 为 fork 列表；新增 `type='parallel'` 节点；前端时间线分叉展示 | 本轮 WP1 或签合入后 |
| Multitable M0 抽取 | 从 `univer-meta.ts` 抽出 `provisioning.ts` / `loaders.ts` / `access.ts` | 无（可独立启动） |
| Wave 2 WP2 统一 Inbox（PLM 接入） | PLM 审批纳入 `/api/approvals`，`sourceSystem` 分层 | 无（可独立启动） |

---

## 8. 附录：验收命令速查

### WP1

```bash
cd .worktrees/wp1

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-wp1-any-mode.api.test.ts \
    tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot

pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

### Redis

```bash
cd .worktrees/redis

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/redis-token-bucket-store.test.ts \
  tests/unit/redis-circuit-breaker-store.test.ts \
  tests/unit/rate-limiter.test.ts --reporter=dot
```

### Audit UI

```bash
cd .worktrees/audit-ui

pnpm --filter @metasheet/web exec vue-tsc --noEmit

pnpm --filter @metasheet/web exec vitest run \
  tests/adminAuditView.spec.ts \
  tests/directoryManagementView.spec.ts --reporter=dot
```

---

## 9. 索引（6 个独立 MD）

| 通道 | 类型 | 相对 worktree 路径 |
|---|---|---|
| 1 | 开发 | `.worktrees/wp1/docs/development/approval-wave2-wp1-runtime-development-20260420.md` |
| 1 | 验证 | `.worktrees/wp1/docs/development/approval-wave2-wp1-runtime-verification-20260420.md` |
| 2 | 开发 | `.worktrees/redis/docs/development/collab-infra-redis-runtime-development-20260420.md` |
| 2 | 验证 | `.worktrees/redis/docs/development/collab-infra-redis-runtime-verification-20260420.md` |
| 3 | 开发 | `.worktrees/audit-ui/docs/development/audit-log-ui-frontend-development-20260420.md` |
| 3 | 验证 | `.worktrees/audit-ui/docs/development/audit-log-ui-frontend-verification-20260420.md` |

---

## 10. 2026-04-21 Rebase 回传

### 清理 + rebase 结果

| 通道 | 脏改动 | 清理方式 | Rebase 冲突 | 业务 diff 行数 rebase 前后 |
|---|---|---|---|---|
| WP1 | 26 个 `plugins/*/node_modules` + `tools/cli/node_modules` 符号链接 | `git checkout -- plugins/ tools/` | 无 | +1032 / −22（不变） |
| Redis | 同上 26 个 | 同上 | 无 | +2218 / −4（不变） |
| Audit UI | 同上 26 个 | 同上 | 无 | +635 / −174（不变） |

注：`git checkout -- plugins/ tools/` 是精确回滚 working-tree 对特定路径的未提交改动，不碰业务 commit。预先用 `git status --porcelain | grep -vE '^ M (plugins/|tools/)'` 验证脏项只限这两条路径后再执行。

### 重跑验收结果（均 rebase 后）

| 通道 | 命令 | 结果 |
|---|---|---|
| WP1 | `tsc --noEmit` | PASS（零诊断） |
| WP1 | `vue-tsc --noEmit` | PASS（零诊断） |
| WP1 | `vitest run tests/integration/approval-wp1-any-mode.api.test.ts`（单独） | PASS 1/1 |
| WP1 | `vitest run tests/integration/approval-pack1a-lifecycle.api.test.ts`（单独） | PASS 3/3 |
| WP1 | `vitest run tests/unit/approval-graph-executor.test.ts` | PASS 8/8 |
| Redis | `tsc --noEmit` | PASS（零诊断） |
| Redis | `vitest run tests/unit/redis-token-bucket-store.test.ts tests/unit/redis-circuit-breaker-store.test.ts tests/unit/rate-limiter.test.ts` | PASS 40/40（11+14+15） |
| Audit UI | `vue-tsc --noEmit` | PASS（零诊断） |
| Audit UI | `vitest run tests/adminAuditView.spec.ts tests/directoryManagementView.spec.ts` | PASS 38/38（5+33） |

### 已知并发风险（WP1）

`approval-wp1-any-mode.api.test.ts` 与 `approval-pack1a-lifecycle.api.test.ts` 被 vitest 同进程同批次并行运行时，两个测试文件的 `ensureApprovalTables()` 会各自 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` 同一 `approval_records_action_check`，中间 window 有竞态——其一失败报 `42710 duplicate_object`；紧随其后的 unique index 同样会报 `23505 pg_class` 冲突。

- 本轮验收workaround：两个文件分两次 `vitest run` 调用，各自独立 worker，race 消失
- PR 合并前的 CI 配置：保持各 integration 文件独立运行即可通过（与本 PR 预期一致）
- 正确的 fixture 修复（follow-up，不在本 PR 范围）：把 `ensureApprovalTables` 全部 DDL 包进 `pool.connect() + BEGIN + pg_advisory_xact_lock(...) + COMMIT`，让跨 session 的并发调用被串行化。Pack 1A 同一模式也将受益。

### 待办门禁

| 通道 | PR-open 前必须 | PR-open 后可跟进 |
|---|---|---|
| WP1 | 人工复核 diff + 验收输出 | fixture 并发安全（advisory lock）follow-up PR |
| Redis | 人工复核 diff + **live-Redis smoke 输出附到 verification MD** | APIGateway wiring 切到 Redis；AutomationScheduler Redis 化；可选 Docker-compose smoke CI job |
| Audit UI | 人工复核 diff + 验收输出 | 会话撤销后端接入后点亮第二面板 |

### 复核要点

- 三条分支均已在 `.worktrees/*` 本地完成 `git rebase origin/main`，未 push 到 origin
- 业务 commit 行数 / 文件清单与 2026-04-20 初次交付一致
- 不建议把这三条混入主工作树（主工作树正在处理 YJS / #960 未提交工作）
