# admin 读侧补门 批次 3（ADM-05 / #5678）— 验证记录

- 日期：2026-09-20（+08:00，`Get-Date` 实读）
- 分支：`fix/admin-read-gates-batch3`，worktree `metasheet-wt-w7i`，基线 `origin/main` = `6ea19e2de`
- 设计见 `admin-read-gates-batch3-design-20260920.md`

所有命令在本机 Windows 上跑；CI 是裁判，本文件只记录本机结果。

## 0. 开工前置：#5680 状态

```
gh pr view 5680 --repo zensgit/metasheet2 --json state,mergedAt
-> {"mergedAt":null,"state":"OPEN", ...}
```

因此本批**不动** `GET /slo/status`，理由与后续见设计稿。

## 1. 新 spec

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-read-gates-batch3-authz.test.ts --reporter=dot
```

结果：`Test Files 1 passed (1)` / `Tests 25 passed (25)`。

## 2. 相邻 spec 不回归

第一轮（任务点名的六个 + 安全确认相关 + **结构性闭世界守卫**）：

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-read-gates-batch2-authz.test.ts \
  tests/unit/admin-dlq-read-authz.test.ts \
  tests/unit/protection-rules-authz.test.ts \
  tests/unit/require-admin-role-fail-closed.test.ts \
  tests/unit/admin-yjs-status-routes.test.ts \
  tests/unit/protection-rules-ratelimit-bounded.test.ts \
  tests/unit/multitable-sheet-liveness-closure-all-routes.guard.test.ts \
  tests/unit/admin-safety-confirm-authz.test.ts \
  tests/unit/safety-guard-confirm-flow.test.ts --reporter=dot
```

结果：`Test Files 9 passed (9)` / `Tests 151 passed (151)`。

其中 `multitable-sheet-liveness-closure-all-routes.guard.test.ts`（73 例）是本批**最需要盯的**一条：它有一条 `OPAQUE_REGISTRATIONS['routes/admin-routes.ts']['GET /safety/status']` 记录，`handler` 字段逐字比对 `createSafetyStatusEndpoint()`。扫描器只把**最后一个** handler 参数当 handler（`tests/utils/sheet-liveness-route-scan.ts:550`），所以在前面插 `requireAdminRole()` 不改 `o.handler`，该记录无需修改——实跑全绿印证。

第二轮（补齐所有引用 `admin-routes` 的 unit spec）：

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-snapshot-delete-authz.test.ts \
  tests/unit/snapshot-labels-authz.test.ts \
  tests/unit/snapshots-safety-guard.test.ts \
  tests/unit/admin-read-gates-batch3-authz.test.ts \
  tests/unit/require-admin-role-fail-closed.test.ts --reporter=dot
```

结果：`Test Files 5 passed (5)` / `Tests 44 passed (44)`。

（引用清单来自 `grep -rln "admin-routes" tests/unit tests/integration tests/contract`：12 个 unit spec 全跑过，剩下 1 个是 `tests/integration/directory-binding-sync-hook.db.test.ts`，需要真库，不在本机跑。）

## 3. 类型检查

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

结果：无输出、退出 0。

## 4. 变异自证（内存级，逐条定位）

手法：**不改盘上任何仓库文件**。变异 harness 全部在 scratchpad（`…/scratchpad/w7i/w7i-mutate.config.mjs` + `w7i-mutate-setup.ts`），通过 `vitest run --config <scratchpad 配置>` 注入一个 setup 文件，该文件用 `vi.mock` 把 `src/guards/index.ts` 的 `requireAdminRole` 换成一个包装：请求进来时读 `W7I_MUTATE_ROUTE` 环境变量，**只对被点名的那一条路由**走 passthrough（`next()`），其余路由照常调真实守卫。mock 活在 vitest worker 的模块注册表里，跑完即消失，仓库对象库零变更（并行代理共用同一仓库，落盘变异会互相污染）。

对照组（`W7I_MUTATE_ROUTE` 未设置，走同一 harness）：`Test Files 1 passed (1)` / `Tests 25 passed (25)` —— 证明 harness 本身不改变行为。

四次变异：

| 变异（门→passthrough） | 结果 | 变红的用例 |
| --- | --- | --- |
| `/safety/status` | 6 failed / 19 passed | 该路由的 非管理员 403 / 未认证 403 / RBAC 503 / 门在首位 + 四条全门扫描 + 闭世界扫描 |
| `/ratelimits` | 7 failed / 18 passed | 同上四条 + 「限流配置不可读」 + 四条全门扫描 + 闭世界扫描 |
| `/ratelimits/:key` | 7 failed / 18 passed | 同上四条 + 「每键桶预言机不可达」 + 四条全门扫描 + 闭世界扫描 |
| `/health/summary` | 7 failed / 18 passed | 同上四条 + 「degraded 标志不可轮询」 + 四条全门扫描 + 闭世界扫描 |

定位性：每次变异只红被点名路由自己的用例（外加两条本就跨路由的扫描用例），**没有**红到其它三条路由的任何用例——即这 4 个门各自被独立钉住，不是靠一条笼统断言凑出来的。

`platform-admin -> 200` 用例在变异下仍绿，符合预期：把门拿掉不影响管理员路径，它钉的是另一件事（管理员侧响应形状零变化）。

## 5. 闭世界用例的方向性

新 spec 最后一条遍历 router 上每个 GET layer，对非管理员跑 `stack[0]`，断言"没能产出 403 的路由集合"恰好 `=== ['/slo/status']`。

- 反向（门被拿掉）：上表四次变异里它每次都红 —— 集合里多出被变异的那条。
- 正向（门被补上）：#5680 合入后给 `/slo/status` 加门的那天，集合变空，这条用例也会红。这是故意的：它是接力棒，后续 PR 必须显式改它，忘不掉。

## 6. 提交面

```
git diff --stat origin/main
git diff origin/main | grep -P '\x08'   # 空
```

改动文件：

- `packages/core-backend/src/routes/admin-routes.ts`（4 处加门 + 4 段 SECURITY 注释）
- `packages/core-backend/tests/unit/admin-read-gates-batch3-authz.test.ts`（新增）
- `packages/core-backend/tests/unit/admin-read-gates-batch2-authz.test.ts`（文件头注释里"这 5 条仍无门"的陈述在本树上已失效，补一句指向批次 3；无用例改动）
- `docs/development/admin-read-gates-batch3-design-20260920.md`、`docs/development/admin-read-gates-batch3-verification-20260920.md`（新增）
- `docs/development/admin-read-gates-batch1-design-20260914.md`（在"口径待定"那条下补一行指针，修 #5884 反驳者指出的文档断链）

scratchpad 里的 harness 不进提交；提交前 `git status` 已核，无 `w7i-` 残留。
