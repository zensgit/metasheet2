# H-1 验证 —— 审批节点超时效果 vs 异步 metrics 激活写入竞态

> **状态：PROPOSED（候选证据包，未裁决）。** 配套设计：
> `docs/development/h1-approval-node-timeout-activation-race-design-20260922.md`。
> 本文只记录**本轮实际执行过**的命令与其输出；没跑的一律进 §7 NOT RUN 清单。

- 分支：`fix/approval-node-timeout-effect-activation-race`
- 基线 / 分支点：`origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- 变更文件：2 个（生产 1 + 测试 1），`+221 / -8`，**零迁移、零 DDL、零新错误码**

---

## 1. 环境（写进报告的部分，含与 CI 的差）

| 项 | 本地值 | CI（`approval-realdb-l6a-roundscoping.yml`） | 差异是否已披露 |
|---|---|---|---|
| PostgreSQL | **15.17 (Homebrew, aarch64-apple-darwin25.2.0)** | `postgres:16` 容器 | **是** —— 设计 MD §7 R4 |
| Node | 两条轴都跑了：**v25.9.0**（默认）与 **v20.20.2**（nvm，= CI 大版本） | `node-version: 20.x` | 见 §4.3 |
| vitest | 1.6.1 | 同仓 lockfile | — |
| 包管理 | **未用 pnpm**，直调 `./node_modules/.bin/{tsx,vitest,tsc}` | `pnpm 10.16.1 exec` | `exec` 只做 bin 解析，直调等价；绕开是为了不让本机 pnpm 改写 lockfile |
| 依赖树 | 工作树 `node_modules` 软链到 canonical（根 / apps/web / packages/core-backend / plugins/*，共 9 条） | `pnpm install --frozen-lockfile` | — |
| 一次性库 | `metasheet2_h1_20260922`，owner **`ms2testbed`（非超级）**；`postgres` 超级用户**只**用于 `createdb` / `dropdb` | `postgres:postgres@…/metasheet_approval_realdb` | — |
| 连接串变量 | **只有 `DATABASE_URL`**（`src/integration/db/connection-pool.ts:200` 经 `secretManager.get('DATABASE_URL')` → `SecretManager.ts:19` `process.env[key]`；`migrate.ts` 走同一 `db`）。全仓 `.github/workflows/*.yml` + `package.json` 的连接串变量普查后无第二个 | 同名 | 每次运行前 `psql -tAc "select current_database(), current_user"` 核过 = `metasheet2_h1_20260922 \| ms2testbed` |
| 迁移排除 | `MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql` | **与 l6a workflow 逐字相同** | — |
| 并发参数 | `vitest.integration.config.ts` 原样（`pool:'forks'` / `fileParallelism:false` / `maxConcurrency:1`） | 同 | — |
| `CI=true` | 每次运行都置 | — | — |

**受保护库从未被指向**：`metasheet_test` / `metasheet_v2` / `metasheet_testbed_*` 在本轮全程零引用，
`DATABASE_URL` 每次都显式 export 到一次性库。

---

## 2. 注入方式（与私有报告同族，但**不改生产代码**）

私有报告的复现靠在 `ApprovalMetricsService.ts` 的 fire-and-forget 写侧**注入 `setTimeout`**（改生产文件），
并扫 190–250ms 才命中 ~3–5ms 的窗口 —— 概率性的。

本轮把同一个扰动搬到**测试侧**并**去掉概率性**：

- `installLateActivationStamp(instanceId, nodeKey, delayMs)`
  （`approval-dedup-return-round-scoping.db.test.ts:709`）把**共享 metrics 单例**
  （`getApprovalMetricsService()`，`ApprovalMetricsService.ts:1044`，`ApprovalProductService.ts:5296`
  的默认构造参数捕获的就是这个对象）上的 `recordNodeActivation` 替换成一个**自有属性**，
  只拦截第一次、且只拦截 `(instanceId, nodeKey)` 匹配的那次调用，先 `await sleep(delayMs)` 再委托原方法，
  完成后 resolve 一个 `landed` promise。`restore()` 用 `delete` 摘掉自有属性，原型方法归位。
- **零生产 test hook、零 env 开关、零 `ApprovalMetricsService` 改动。**
- `delayMs = 1200ms`（`:696`）。夹具 `forceDeadlineOverdue` 的稳定性轮询固定在 ~200ms 退出
  （4 次迭代 × 50ms），1200 ≫ 200 ⇒ **交错被固定**，不是扫出来的。

**为什么这样就确定性了**（两支都推过并实测）：

| | 旧实现（fire-and-forget） | 新实现（await settle） |
|---|---|---|
| approve 请求 | 立即返回；激活写卡在 1200ms 的门后 | **阻塞 ~1200ms**，写落库后才返回 |
| `forceDeadlineOverdue` 轮询 | 读到「未 armed」签名 `null\|null`，~200ms 稳定退出，强制 UPDATE 写入过期值 | 读到 `jump\|set`，~200ms 退出，强制 UPDATE 写入过期值 |
| 用例显式 `await landed` | 等到 ~1200ms，**迟到的写此刻落库**，把过期值改写成 `activatedAt+60s`（未来） | 早已 resolve，**不写任何东西** |
| `applyNodeTimeoutEffect` | 守卫 `deadlineMs > Date.now()` 取真 → `'skipped_stale'` | 四支全假 → `'applied'` |

---

## 3. Mutation（判别力证明 + 旧实现回跑）

**mutation 的构造**：`cp` 备份 → 把 5 个调用点的 `await this.emitNodeActivationMetric(`
机械替换成 `void this.emitNodeActivationMetric(`（= 恢复「派发即返回」，即旧实现的语义）→ 跑 → `cp` 还原 → `cmp`。
**全程未用 `git checkout --` / `reset --hard` / `stash`。**

```
python3: MUTATED sites: 5
grep -c "void this.emitNodeActivationMetric("  → 5
```

| 运行 | 库 | 结果 |
|---|---|---|
| **A. 基线（pristine `cd42eaf74…`，无本 PR）** | 新建 + 迁移 | `Test Files 1 passed (1)` / `Tests 8 passed (8)` / Duration 7.19s |
| **B. 本 PR（fix + 2 条新用例）** | 新建 + 迁移 | `Test Files 1 passed (1)` / **`Tests 10 passed (10)`** / Duration 8.80s |
| **C. mutation（fix 的实现回退成 fire-and-forget，用例不变）** | **新建 + 迁移**（不复用 B 的库） | `Test Files 1 failed (1)` / **`Tests 2 failed \| 8 passed (10)`** / Duration 8.96s |

C 的两条红，逐字：

```
× H-1 DISCRIMINATOR: the node-activation deadline stamp is DURABLE before the action response returns
  → the activating node's timeout effect must be durable by the time the action response returns:
    expected null to be 'jump' // Object.is equality

× H-1 GATE: a LATE activation re-stamp does NOT overwrite an already-overdue armed state — the timeout effect still applies
  → a late activation re-stamp must not be able to overwrite the armed overdue state and make the
    timeout effect skip as stale: expected 'skipped_stale' to be 'applied' // Object.is equality
```

**第二条与 CI 那次红的断言逐字相同**（`expected 'skipped_stale' to be 'applied'`）——
即本 PR 的用例在旧实现上复现的，就是 lane 上观测到的那个失败，且**不再是 1.1% 的概率事件**。

C 里**原有 8 条用例全部保持绿** ⇒ 新增的两条用例是**唯一**对本次改动有判别力的断言，
mutation 没有顺带打红别的东西（`feedback_confounded_mutation_needs_isolated_variant_grid`）。

**还原核对**：

```
cmp <备份> <工作树文件>   → CMP_IDENTICAL
grep -c "await this.emitNodeActivationMetric("  → 5
grep -c "void this.emitNodeActivationMetric("   → 0
```

**「新用例不是空转」的正控**：两条用例内都断言
`expect(await landedWithin(hook.landed, 15000)).toBe(true)`
（`:788` / `:824`）—— 如果拦截根本没装上（比如单例不是同一个对象、或 `nodeKey` 打错），
`landed` 永不 resolve，这条正控先红。两条用例在 B 中都是绿的，即**拦截确实执行了**。

---

## 4. 全量跑

### 4.1 目标 lane（`approval-realdb-l6a-roundscoping`）

命令与 workflow step 逐字一致（除 `pnpm exec` → 直调 bin）：

```
DATABASE_URL=postgresql://ms2testbed@127.0.0.1:5432/metasheet2_h1_20260922 EXPECT_DB=1 NODE_ENV=test CI=true \
  ./node_modules/.bin/vitest --config vitest.integration.config.ts run \
  tests/integration/approval-dedup-return-round-scoping.db.test.ts --reporter=verbose
```

结果见 §3 表 B：**10 passed (10)**，含 lane 的 anti-skip-green sentinel
（`sentinel: EXPECT_DB lane must have DATABASE_URL`）命中。

### 4.2 邻居（93 个 approval / automation-approval / attendance-w4c3b 集成套件）

| 批次 | 库 | Test Files | Tests |
|---|---|---|---|
| 本 PR | 新建 + 迁移 | 3 failed \| 90 passed (93) | 11 failed \| 1018 passed (1029) |
| **pristine 同批对照**（用 `git show HEAD:<f> > <f>` 还原两个文件，非 `git checkout --`） | 新建 + 迁移 | 3 failed \| 90 passed (93) | 11 failed \| 1016 passed (1027) |

失败集合：`approval-wp3-reads.api.test.ts`(5) / `approval-wp3-pending-count.api.test.ts`(4) /
`approval-sequential-mode.db.test.ts`(2)。

**归因（已实测，不是推断）**：这 11 条全是 `expected 27 to be 3` / `expected 26 to be 2` /
`expected 24 to be +0` 这一族的**计数被污染**，典型的 shared-DB 夹具串扰
（`feedback_shared_db_integration_fixture_collision`）—— 把 93 个套件塞进**同一个库**才会出现；
CI 里每条 lane 各自一个容器库，不会有这个形状。

**判别实验**：同样的 3 个文件、**带本 PR 的改动**、放进**全新库**单独跑：

```
Test Files  3 passed (3)
Tests  25 passed (25)
```

⇒ 失败由**批跑共库**引起，与本 PR 无关。pristine 同批对照进一步给出同侧证据（上表第 2 行）。

### 4.3 Node 版本轴

两条轴都跑了本 lane 的目标套件（每次都新建库 + 重跑迁移）：

| Node | 实现 | 结果 |
|---|---|---|
| v25.9.0（本机默认） | 本 PR | `Tests 10 passed (10)`，Duration 8.80s |
| v25.9.0 | mutation | `Tests 2 failed \| 8 passed (10)` |
| **v20.20.2（nvm，= CI 的 `node-version: 20.x` 大版本）** | 本 PR | `Tests 10 passed (10)`，Duration 9.92s；两条新用例 1254ms / 1466ms |
| **v20.20.2** | mutation | `Tests 2 failed \| 8 passed (10)`，两条断言与 §3 逐字相同 |

**为什么这条轴必须跑**：本 PR 改的是**异步落地顺序**，而 Node 主版本之间微任务/IO 调度有差异。
两个大版本上判别力一致 ⇒ 结论不是某个 runtime 的偶然。

（node 20 下日志里另有一条既有噪声 `Failed to load plugin from …/plugins/plugin-view-kanban:
SyntaxError: Unexpected token '{'` —— 与本 PR 无关，两种实现下都出现，且 10 条用例照常收集与执行。）

### 4.4 tsc

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json        → 退出码 0，零输出
```

**注意（如实记）**：`packages/core-backend/tsconfig.json` 的 `include` 是
`["src/**/*","core/**/*","types/**/*", …]` —— **不含 `tests/`**。所以上面那条命令**没有**类型检查测试文件。
为此另跑了一次把本测试文件加进 `include` 的一次性 config：

```
tsc --noEmit -p <tmp tsconfig，include 增加 tests/integration/approval-dedup-return-round-scoping.db.test.ts>
  → 该文件零诊断
```
（一次性 config 跑完即删，未留在工作树。）

---

## 5. 延迟实测（await settle 的代价）

一次性探针（本轮自建的 `h1-latency-probe.test.ts`，**跑完已删、未进提交**）：建一条
A(P) → C(Q, `timeout{afterMinutes:1,effect:'jump'}`) 的模板，重复 N 次「创建 → 计时 approve →
删除该实例的全部行」，计时的是 **`POST /api/approvals/:id/actions` 的完整 HTTP 往返**
（即 §3 里被 await 的那条激活写所在的请求）。Node v20.20.2，每次新建库 + 迁移，串行。

| 实现 | n | median | min | max |
|---|---|---|---|---|
| 旧（`void`，派发即返回） | 25 | **6.11 ms** | 4.17 ms | 31.22 ms |
| 本 PR（`await` settle） | 25 | **5.48 ms** | 3.80 ms | 24.24 ms |
| 旧 | 9 | 7.33 ms | 5.88 ms | 33.29 ms |
| 本 PR | 9 | 6.74 ms | 5.01 ms | 25.89 ms |

**如实解读，不夸大**：四组里 await 版的中位数都**略低**（n=25 时低 0.63ms，尾部也低），
但这**不是**「await 更快」的结论 —— 差值小于本探针的运行间噪声。可以说的只有：
**在本地热连接池、单客户端串行的条件下，await settle 没有产生可测量的延迟回归**。
设计 MD 预估的「≈5 次往返」在这里被池复用与事务批处理吸收掉了。

一个可能的机制（**假设，未验证**）：fire-and-forget 时那条 detached 写会漂到**下一个**请求的
时间窗里争事件循环与连接，反而给后续请求加抖动；await 把它固定在制造它的那个请求里。
**没有做实验证伪这个假设**，只作为观察记录。

**这条数据的边界（必须一起读）**：单客户端、串行、本地热池、n=25。
它**不是**并发压测，**不能**外推到「高并发下也没有回归」—— 见 §7 第 2 条。

---

## 6. CI 触发面核对

本 PR 改的两个文件：

| 文件 | 在 l6a workflow 的 `paths:` 里？ |
|---|---|
| `packages/core-backend/src/services/ApprovalProductService.ts` | **是**（`approval-realdb-l6a-roundscoping.yml:31` / `:44`） |
| `packages/core-backend/tests/integration/approval-dedup-return-round-scoping.db.test.ts` | **是**（`:30` / `:43`） |

⇒ **两条新用例会在 PR 上真的跑**，不是加了没人跑的死代码（`feedback_apps_web_specs_ungated` 的反面核对）。
本 PR **未**新增测试文件、**未**改 `plugin-tests.yml`、**未**改 `vitest.config.ts` 的 `exclude`
⇒ 不触发 s6a pin / W7-R10 分类 / CI corpus 的任何一钉。
`ApprovalMetricsService.ts` 一行未改，所以以该文件为 `paths:` 的 lane 不被本 PR 触发（也无需触发）。

---

## 7. NOT RUN / 未声称（逐条）

1. **PostgreSQL 16 未跑。** 本地全部在 PG 15.17。本 PR 零 SQL 变更，理由上与版本无关，但**没有 16 的本地实测**。
2. **并发/负载下的连接池压测未做。** 「持有审批连接的同时取第二条连接」在高并发下的池压力没有实测数字；
   设计 MD §7 R3 已按「既有形状的边际增量」记录，**「边际」二字无实测支撑**。
3. **R1（跨请求真并发乱序）未构造、未测、未修。** 本 PR 不声称关闭它。
4. **R2（`recordTerminal` 无作用域清空）未修、未构造反例。** 只做了可达性与危害有界的论证。
5. **未在本地自然复现**（不注入延迟）。本轮所有红都来自**确定性注入**；自然发生率仍只由 CI 侧观测
   （262 次 3 次 ≈1.1%，私有报告 §5）给出。本 PR 也**不**声称「把 1.1% 降到了 0」——
   可声称的是「被点名那条序列上的失败模式，在新实现下结构性不可达，且旧实现下确定性可复现」。
6. **未改测试夹具 `forceDeadlineOverdue` 的稳定性轮询。** 私有报告给 owner 的选项 (b) 未实施。
7. **apps/web / 前端未跑**（本 PR 不碰前端）；**`vitest.config.ts` 默认无 DB lane 未全量跑**
   （本 PR 不改其 `exclude`，且改动文件不在其收集范围外）。
8. **未合并、未 undraft、未改锁文正文、未翻任何开关、未部署、未跑任何迁移到非一次性库。**

---

## 8. 资源与清理

- 工作树：`…/6f6639a7-…/scratchpad/h1-timeout-race`（分支 `fix/approval-node-timeout-effect-activation-race`），
  收尾 `git worktree remove` 点名全路径移除；9 条 `node_modules` 软链逐条判 `-L` 再 `rm`。
- 一次性库 `metasheet2_h1_20260922`：本轮多次 `dropdb` + `createdb`（每个批次前重建，不复用脏状态），
  收尾 `dropdb`。owner `ms2testbed`（非超级）；`postgres` 超级用户只用于建删库。
- 备份目录（`cp` 备份，非 git 操作）：`…/scratchpad/h1-mutbak/`、`…/scratchpad/h1-fixbak/`。
- 临时延迟探针文件（`h1-latency-probe.test.ts`）为本轮自建，跑完即删，**未进提交**。
- 未 kill 任何不是本轮起的进程；未删任何不是本轮建的 worktree / 库 / 文件。
- 登记：`~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/soak-working/resource-inventory-20260920.md`。
