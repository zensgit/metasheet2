# DLQ `list({ limit: 0 })` 修复 —— 验证记录(2026-09-14)

worktree: `C:/Users/zhou/Downloads/dev/metasheet-wt-w5f`,分支 `fix/dlq-list-limit-zero`,起点 `origin/main` @ `ce9da32ae`。

## 1. 红(修复前)

命令:

```
cd packages/core-backend && npx vitest run tests/unit/DeadLetterQueueService.test.ts
```

结果:`Test Files 1 failed (1)` / `Tests 1 failed | 8 passed (9)`。失败用例 `limit: 0 returns items: [] with correct total and skips the row query`,报错 `TypeError: Cannot read properties of undefined (reading 'map')`(因为 mock 的 `execute` 未被 stub,`items` 为 `undefined`,与"改动前 `.limit(0||50)` 真的会去拉行"这一缺陷行为一致:测试特意不给 `execute` 打桩来断言"根本不应该发行查询")。

## 2. 绿(修复后)

对 `DeadLetterQueueService.ts` 的 `list()` 加入 `options.limit === 0` 短路分支后重跑同一命令:

结果:`Test Files 1 passed (1)` / `Tests 9 passed (9)`。

## 3. 变异(mutation)

把新加的短路分支临时删除(还原成修复前的 `list()` 实现),重跑同一 spec:

结果:`Test Files 1 failed (1)` / `Tests 1 failed | 8 passed (9)`,失败用例与"红"阶段完全一致(`limit: 0` 用例, `Cannot read properties of undefined (reading 'map')`)。确认新测试能捕获该缺陷的复发。

随后恢复短路分支,重跑确认回到 9/9 绿。

## 4. 相邻 spec

文件名含 `dlq` / `dead-letter` / `admin` 的 spec(`packages/core-backend/tests` 下用 `find -iname` 枚举,`dlq`/`dead-letter` 只命中 `DeadLetterQueueService.test.ts` 本身,另按内容关键字命中 `AdvancedMessaging.test.ts` 一并纳入):

```
tests/unit/admin-directory-routes.test.ts
tests/unit/admin-safety-confirm-authz.test.ts
tests/unit/admin-snapshot-delete-authz.test.ts
tests/unit/admin-users-activate-error-closure.test.ts
tests/unit/admin-users-activate-error-leak.test.ts
tests/unit/admin-users-activate-error-mapping.test.ts
tests/unit/admin-users-routes.test.ts
tests/unit/admin-yjs-status-routes.test.ts
tests/unit/AdvancedMessaging.test.ts
```

命令:

```
npx vitest run <上述9个文件路径>
```

结果:`Test Files 9 passed (9)` / `Tests 258 passed (258)`。这些 spec 均不涉及 `routes/admin-routes.ts` 的 DLQ 路由(本次未改动该文件),运行只为确认没有意外的跨文件副作用。

## 5. 类型检查(tsc --noEmit)

包级(`src` 全量,沿用现有 `tsconfig.json`,已排除测试文件):

```
cd packages/core-backend && npx tsc --noEmit -p tsconfig.json
```

结果:无输出(干净)。

新 spec 单独检查:包 `tsconfig.json` 的 `exclude` 排除了 `**/*.test.ts`,新增测试断言不会被包级 tsc 覆盖。建了一个临时 tsconfig(`tsconfig.w5f-spec-check.tmp.json`,extends 现有 `tsconfig.json`,仅追加 `include: ["tests/unit/DeadLetterQueueService.test.ts", "src/**/*"]`,并保留对 `src/**/*.test.ts` 与 `src/**/__tests__/**` 的排除以避免拉入大量与本次改动无关的既有类型问题),运行:

```
npx tsc --noEmit -p tsconfig.w5f-spec-check.tmp.json
```

结果:无输出(干净)。**临时 tsconfig 文件已在检查后删除,未提交入库。**

（第一次尝试把 `src/**/*` 不带排除地纳入临时 tsconfig 时,拉出了一批与本次改动无关的既有类型错误 —— attendance/`w4c3c-active-current`、`w7-context-source-transition`、`cache/null-cache`、`redis-cache`、`registry`、`view-service`、`health-aggregator`、`pattern-manager`、`permission-metrics`、`sharding-e2e`、`BPMNWorkflowEngine.timer*`、`attendance-w4c3a-raw-evidence` 等,均是既有测试文件类型问题,与本次 `DeadLetterQueueService.ts` 改动无关,补上排除测试目录后消失,未做任何修复。）

## 6. 其它调用方核查

见 `dlq-list-limit-zero-design-20260914.md` 的"调用方核查"一节;结论:无调用方期待 `limit: 0` 返回 50 行。

## 7. 未做事项

- 未运行 core-backend 全量测试套件(耗时/超出任务范围,只跑了目标 spec + 相邻 spec)。
- 未跑集成测试(该服务的行为是纯 kysely 查询构建层面,集成测试需要真实 PG,未在本任务范围内配置)。
- 未 push、未开 PR(按任务要求)。

## 轻量复核（查找者 + 裁决：可合）

- **[已声明补充] `POST /api/admin/dlq/retry-all`**（`admin-routes.ts:1631` `const { limit = 100 } = req.body`，解构默认只对 undefined 生效）：请求体 `{"limit":0}` 现在命中短路 → 一条都不重试（`retried:0`、`remaining:total`）；改前最多重试 50 条。方向保守且「limit 0 = 重试 0 条」语义更对，但属**写端点**行为变化，正文已补。
- **[信息] spec 背书强度**：mock 里所有 builder `mockReturnThis()`、`selectFrom()` 返回 `db` 自身，运行期 `query === countQuery`，因此「短路后 total 仍按 status/topic 过滤计」这条**靠代码阅读成立（`:157/:162` 对 countQuery 同样 `.where`）**，spec 不背书——删掉那两行 `countQuery.where` 整套 spec 仍绿。留待有真库道时钉。
- 核过清白：主断言非空转（兄弟用例须显式 `execute.mockResolvedValueOnce([])` 才过；count 不跑则 total=0≠42）；短路在 `total` 之后；`?limit=` 空串经 `admin-routes.ts:1406` `limit ? Number(limit) : undefined` 仍回落 50（只有字面 `?limit=0`/`-0` 短路）；其它调用方（HealthAggregator limit:1、AdvancedMessaging 整模块 mock）不受影响；CI 必过泳道收；与 origin/main 现头 `merge-tree` 零冲突。

