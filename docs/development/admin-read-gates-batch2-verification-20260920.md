# admin 读侧补门 批次 2（ADM-05 / #5678）— 验证记录

- 日期：2026-09-20（+08:00，`Get-Date` 实读）
- 分支：`fix/admin-read-gates-batch2`，worktree `metasheet-wt-w7d1`，基线 `origin/main`
- 设计见 `admin-read-gates-batch2-design-20260920.md`

所有命令在本机 Windows 上跑；CI 是裁判，本文件只记录本机结果。

## 1. 新 spec

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-read-gates-batch2-authz.test.ts --reporter=dot
```

结果：`Test Files 1 passed (1)` / `Tests 28 passed (28)`。

## 2. 相邻 spec 不回归

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/admin-read-gates-batch2-authz.test.ts \
  tests/unit/admin-dlq-read-authz.test.ts \
  tests/unit/protection-rules-authz.test.ts \
  tests/unit/require-admin-role-fail-closed.test.ts \
  tests/unit/admin-yjs-status-routes.test.ts --reporter=dot
```

结果：`Test Files 5 passed (5)` / `Tests 55 passed (55)`。

## 3. 类型检查

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

结果：无输出、退出 0。

## 4. 变异自证

两个镜头，**都在内存里做**：不改盘上文件，不落任何变异产物（并行代理共用同一仓库对象库）。临时 harness 跑完即删，不进提交——`git status` 在提交前只剩 `admin-routes.ts`（M）与新 spec（??）两项，已核。

### 镜头 A：逐路由把门换成 passthrough（定位性）

手法：`initAdminRoutes()` 拿到 router 后，在内存里把**某一条**路由 express layer 的 `stack[0].handle` 换成 `(_req,_res,next)=>next()`，`afterEach` 还原。

实测顺带确认的一个事实：`admin-routes.ts` 在**模块作用域**的 `Router` 上注册路由，`initAdminRoutes()` 每次返回的是**同一个** router 对象；第一版 harness 没还原，变异跨用例累积，5 例里红了 4 例。补上还原后结果如下。

| 变异的路由 | 该路由对非管理员的响应 | 其余 4 条 |
| --- | --- | --- |
| `GET /shards` | 200（泄漏） | 403 |
| `GET /shards/:name` | 200（泄漏） | 403 |
| `GET /queues` | 200（泄漏） | 403 |
| `GET /health/detailed` | 200（泄漏） | 403 |
| `GET /health/subsystem/:name` | 200（泄漏） | 403 |

即：每条路由的门都是**各自**承重的，去掉任一条只让那一条的 403/503 用例变红，另外四条不受影响。5/5 通过。

（中途一次真实的假阴性排查：`/queues` 变异后先返回 500 而非 200，原因是 harness 的 `afterEach` 用 `vi.restoreAllMocks()` 把 `vi.fn()` 的实现也清了，`dlqService.list` 返回 `undefined` 让 handler 抛错。在 `beforeEach` 里重设实现后得到 200。正式 spec 本来就在 `beforeEach` 里设了实现，不受此影响。）

### 镜头 B：全局把 `requireAdminRole` 换成 passthrough（覆盖性）

手法：把正式 spec 复制成临时文件，加一条 `vi.mock('../../src/guards', …)`，用 `importOriginal()` 保留其余导出、只把 `requireAdminRole` 换成 passthrough，再跑**逐字相同**的断言。

结果：`Tests 23 failed | 5 passed (28)`。

存活的正好是 5 条 `platform-admin -> 200 and the handler still runs unchanged`——它们本来就不测门，测的是管理员侧形状不变，应当存活。也就是说：spec 里每一条与门有关的断言（15 条三态用例 + 5 条首位结构断言 + 3 条跨路由不变量）在门消失时都会红，**没有空断言**。

## 5. values-free 与工具性检查

- 退格字符扫描：`git diff origin/main | grep -P '\x08'` 无输出（Edit 工具把 `\b` 写成 0x08 造空断言的已知坑）。
- 新增代码/文档/PR 正文不含真实主机、IP、口令、appKey、租户 id、客户数据样本；测试夹具用合成名（`shard-fixture-a` 等）。
- 未新增 env flag，未触碰 `.github/`、`plugins/plugin-integration-core/test-chain.txt`、sealed-export 向量。

## 6. 未覆盖 / 残余

- `GET /slo/status`、`GET /safety/status`、`GET /ratelimits`、`GET /ratelimits/:key`、`GET /health/summary` 仍无门（理由见设计稿"本批明确不动"）。这是本树上剩余无门 GET 的**全集**。
- `/shards*` 与 `/health/detailed` 回显的驱动错误文本未脱敏（独立决策点）。
- "运维只读角色 vs 平台管理员"按章程默认前进取 `requireAdminRole()`，标 `Ratified-by-default-2026-09-20`，owner 24h 内可否决。
- 集成/E2E 层未跑（本改动不落 DB、不改挂载点）；Windows 本机既有的几个常红套件与本改动无关，未纳入。
