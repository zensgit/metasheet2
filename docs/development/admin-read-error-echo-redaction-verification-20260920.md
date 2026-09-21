# admin 读侧 GET 的 500 分支脱敏（ADM-05 后续）— 验证

- 日期：2026-09-20
- 分支：`fix/admin-read-error-echo-redaction`
- 环境：本机 Windows，pnpm 9.15.9 / vitest 1.6.1；**未连接任何真实数据库**（全部 doubles 走
  `vi.spyOn` / `vi.mock`，内存级）

## 1. 新 spec

`packages/core-backend/tests/unit/admin-read-error-echo-redaction.test.ts`（18 用例，全绿）

传输层用 `usePinnedServer()` + `request(pinned.url())`，不用 `request(app)`（#4154 零容忍）。

用例构成：

- 13 条 × 每个读侧 GET 一条：装一个抛 `Error(LEAKY)` 的内存 double，断言
  - `status === 500`
  - `body.success === false`
  - `body.code === 'ADMIN_READ_FAILED'`
  - `body.error === '读取失败，详情见服务端日志'`
  - `JSON.stringify(body)` 不含 `LEAKY` 全串，也不含其任一片段
    （`203.0.113.9` / `5432` / `fixture-role` / `ECONNREFUSED` / `password`）
  - 不含 `'at Object'`、`'.ts:'`（栈不上线路）
- 1 条：状态码语义不变（脱敏分支仍是 500，不是 4xx）
- 1 条：`pluginId`（调用者自己在路径里给的）仍被保留
- 1 条：固定文案本身 values-free（不含 host/port/role/driver/path 片段）
- 1 条：变异自证（见 §2）
- 1 条：残余扫描（见 §3）

fixture 的"泄漏串"用 RFC 5737 TEST-NET-3 文档地址 + 字面占位角色名，文件内无任何真实主机、
租户、凭据、路径。

### 各路由的强制失败点（都是内存级 double）

| 路由 | double |
| --- | --- |
| `/plugins`、`/plugins/:id`、`/plugins/:id/config` | `poolManager.get` 抛（非 schema 错误 → 被 `loadPluginRegistry` / `loadPluginConfig` 重抛） |
| `/slo/status` | `sloService.getSLOStatus` reject |
| `/dlq` | `dlqService.list` reject（模块级 mock） |
| `/shards`、`/shards/:name` | `poolManager.getPoolStats` reject |
| `/queues` | `messageBus.getStats` 抛 |
| `/ratelimits` | `getRateLimiter().getGlobalStats` 抛 |
| `/ratelimits/:key` | `getRateLimiter().getStats` 抛 |
| `/health/detailed`、`/health/subsystem/:name` | `getHealthAggregator().checkHealth` reject |
| `/health/summary` | `getLastHealth` → null 强制走新鲜检查，`checkHealth` reject |

运行输出同时证明了另一半契约：服务端日志里确实出现
`error: Failed to get detailed health {... "error":"connect ECONNREFUSED 203.0.113.9:5432 …","stack":"…"}`
——原始 message 与 stack 进了日志，没进 body。

## 2. 变异自证（内存级，无落盘变异）

用例「restoring `error: err.message` on /health/detailed makes the redaction assertion fail」：

在**活的 express router stack 里**把 `/health/detailed` 的最后一个 handler 换成改前那版实现
（`res.status(500).json({ success: false, error: err.message })`），同一请求走同一 pinned server，
然后断言：

- 变异体确实泄漏：`JSON.stringify(res.body)` **包含** `203.0.113.9`
- 同一套断言 `expectRedacted(...)` 在变异体上**抛错**（`expect(...).toThrow()`）

`finally` 里把原 handler 换回去。整个过程不写磁盘、不改源文件，因此并行跑的其它 suite 观察不到
变异体（符合"并行反驳者同树变异互撞"的教训）。

结论：这 13 条用例不是空断言——把任意一处改回 `error: err.message`，对应用例会红。

## 3. 残余扫描用例

用例「no GET route in admin-routes.ts echoes err.message any more」读 `admin-routes.ts` 源文本，
把每个 `error: err.message` / `error: (error as Error).message` 行按行号归属到最近的
`router.<method>(`，断言归属为 `GET` 的集合为空。当前实测：22 个残留回显点全部落在
POST / PUT / DELETE 上，GET 集合为 `[]`。

## 4. 相邻 spec 不回归

```
pnpm exec vitest run \
  tests/unit/admin-read-gates-batch2-authz.test.ts \
  tests/unit/admin-read-gates-batch3-authz.test.ts \
  tests/unit/admin-dlq-read-authz.test.ts \
  tests/unit/require-admin-role-fail-closed.test.ts \
  tests/unit/admin-yjs-status-routes.test.ts
→ Test Files 5 passed (5) / Tests 67 passed (67)
```

另跑了树里其余引用 `admin-routes` / `initAdminRoutes` 的 spec：

```
admin-safety-confirm-authz / admin-snapshot-delete-authz /
multitable-sheet-liveness-closure-all-routes.guard / protection-rules-authz /
protection-rules-ratelimit-bounded / safety-guard-confirm-flow /
snapshot-labels-authz / snapshots-safety-guard
→ Test Files 8 passed (8) / Tests 122 passed (122)
```

新 spec 本身：`Test Files 1 passed (1) / Tests 18 passed (18)`。

## 5. 类型

`pnpm exec tsc --noEmit -p packages/core-backend/tsconfig.json` → 无输出（通过）。

注意该 tsconfig 的 `exclude` 含 `**/*.test.ts`，所以 spec 的类型由 vitest 转译期把关（已绿）。
本 PR 不含前端改动，因此不涉及 `vue-tsc -b`。

## 6. 未做 / 阻塞

- 写侧（POST/PUT/DELETE）的 22 个回显点按设计留作独立决策点，只登记不改（见设计文档 §6，
  并由 §3 的扫描用例托底）。
- `packages/openapi/src` 未改动（这些 500 本就不在契约里），故未重生成 dist / dist-sdk。
- 仓库根 eslint 的 `parserOptions.project` 不包含 `packages/core-backend/src/**`，直接对该文件跑
  `pnpm exec eslint` 会报 parsing error；这是改前既有的配置状况，与本次改动无关，未处理。

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
