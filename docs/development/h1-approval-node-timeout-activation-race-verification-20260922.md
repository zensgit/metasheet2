# H-1 验证 —— 审批节点超时效果 vs 异步 metrics 激活写入竞态

> **状态：PROPOSED（候选证据包，未裁决）。** 配套设计：
> `docs/development/h1-approval-node-timeout-activation-race-design-20260922.md`。
> 本文只记录**本轮实际执行过**的命令与其输出；没跑的一律进 §7 NOT RUN 清单。

- 分支：`fix/approval-node-timeout-effect-activation-race`
- 基线 / 分支点：`origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- 变更文件：3 个（生产 1 + 集成测试 1 + 单元测试 1），**零迁移、零 DDL、零新错误码**

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

本节有**两种**回退，分开记，不混为一谈：

- **mutation**：`cp` 备份 → 把 5 个调用点的 `await this.emitNodeActivationMetric(` 机械替换成
  `void this.emitNodeActivationMetric(` → 跑 → `cp` 还原 → `cmp`。
  它回退的是**「是否等待」这一个变量**，但**不等于**旧实现的逐字语义：
  `void settleMetricsCall(...)` 会同步执行 `fn()` 到第一个 await，而旧实现的 `safeMetricsCall`
  多一个 `Promise.resolve().then(fn)` 的微任务跳板。**这个差别在此无关紧要**（1200ms 的门远大于一个微任务），
  但不能把它说成「就是旧实现」。
- **旧实现逐字回跑（运行 D）**：`git show HEAD~1:<file> > <file>` 把生产文件还原成
  `cd42eaf7455f03dd99021a02c47c42f1f3db6484` 的 blob（`diff` 核对逐字节相同），
  **只保留新用例**，再跑一遍。这才是任务字面要求的「在旧实现上复现」。

**全程未用 `git checkout --` / `reset --hard` / `stash`；两次回退都用 `cp` / `git show >` + `cmp` 还原。**

```
python3: MUTATED sites: 5
grep -c "void this.emitNodeActivationMetric("  → 5
```

| 运行 | 库 | 结果 |
|---|---|---|
| **A. 基线（pristine `cd42eaf74…`，无本 PR）** | 新建 + 迁移 | `Test Files 1 passed (1)` / `Tests 8 passed (8)` / Duration 7.19s |
| **B. 本 PR（fix + 2 条新用例）** | 新建 + 迁移 | `Test Files 1 passed (1)` / **`Tests 10 passed (10)`** / Duration 8.80s |
| **C. mutation（fix 的实现回退成 fire-and-forget，用例不变）** | **新建 + 迁移**（不复用 B 的库） | `Test Files 1 failed (1)` / **`Tests 2 failed \| 8 passed (10)`** / Duration 8.96s |
| **D. 旧实现逐字（生产文件 = `cd42eaf74…` 的 blob，`diff` 零差异；用例 = 新的）** | **新建 + 迁移** | `Test Files 1 failed (1)` / **`Tests 2 failed \| 8 passed (10)`**（Node v20.20.2） |

C 与 D 的两条红**完全相同**，逐字：

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

C 与 D 里**原有 8 条用例全部保持绿** ⇒ 新增的两条用例是**唯一**对本次改动有判别力的断言，
回退没有顺带打红别的东西（`feedback_confounded_mutation_needs_isolated_variant_grid`）。
D 的存在让这条结论不依赖「mutation ≈ 旧实现」这个近似。

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
| **v20.20.2** | **旧实现逐字（运行 D）** | `Tests 2 failed \| 8 passed (10)`，两条断言与 mutation 逐字相同 |

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

### 4.5 默认（无 DB）lane —— **本 PR 在这里打红过一条，已修，记全过程**

这条 lane 就是 main 的 required check `test (20.x)` / `test (18.x)`
（`plugin-tests.yml` 的 "Run core-backend tests" step，`pnpm --filter @metasheet/core-backend test`
= 无 `DATABASE_URL` 的默认 `vitest`）。

**第一次提交（`718a54c2bd0ad1ca46c85f2aae1428e22e8efba3`）时本地没跑这条 lane** ——
当时本文写的理由（「改动文件不在其收集范围外」）是**错的**：l6a workflow 的头注释自述，
正因为该默认 lane **会**收集集成测试，才要把本套件从它的 `exclude` 里剔掉。
结果 CI 上 `test (20.x)` 与 `test (18.x)` 同时红：

```
× tests/unit/approval-product-service.test.ts > ApprovalProductService
  > returns an approval to a previously visited node and reassigns that node
  → expected "spy" to be called 1 times, but got 3 times      (:903 `pgState.client.release`)
```

**这是本 PR 造成的，不是既有 flake**，机制清楚：该文件用 `vi.mock('../../src/db/pg')` 把
`pool` 换成**一个**共享 mock client。`ApprovalMetricsService` 也 import 同一个 `pool`。
`return` 分支的激活 metrics 写现在被 await ⇒ 它自己那条短事务（`mutateBreakdown` →
`defaultTransaction` → `pool.connect()` / `client.release()`）会在断言窗口内借还**同一个** mock client，
`release` 因此从 1 变成 3（审批事务 1 + 被 await 的激活事务 1 + 此时也已落地的 detached decision 事务 1）。

**本地复现并修**：同一条 lane 在本地（Node v20.20.2，`env -u DATABASE_URL CI=true vitest`）跑出
**逐字相同**的一条红（`1 failed | 15890 passed | 1615 skipped (17506)`），即 CI 的红被本地复现。

**修法**：不改断言的语义，也不把字面量从 1 改成 3（3 依赖「detached 的 decision 写此刻恰好落库」，
是把一次时序巧合写进断言 —— 会做出一条会飘的 required lane 用例）。
改为给**这一条**用例注入一个 metrics stub：
`new ApprovalProductService(metricsStub as unknown as ConstructorParameters<typeof ApprovalProductService>[0])`。
这样 `pgState.client.release` 重新只计 `dispatchAction` 自己的连接，
原断言 `toHaveBeenCalledTimes(1)` 逐字保留；并**新增**一条
`expect(metricsStub.recordNodeActivation).toHaveBeenCalledTimes(1)`，
把「return 分支确实发出了再入节点的激活 stamp」显式钉住。

**声明边界（防止被读成「改测试掩盖问题」）**：这条单测的被测对象是 `dispatchAction` 的**事务纪律**，
不是 metrics 的落地顺序；注入 stub 后它对「是否 await」**没有**判别力 —— 判别力在 §3 的 C/D 两次回跑
与 §2 的两条真库用例上，那两条在旧实现下是确定性红的。metrics 写本身的覆盖也没丢：
`tests/unit/approval-metrics-service.test.ts`（SQL 形状）+ 本 PR 新增的真库用例。

**修后本地重跑同一条 lane**：

```
Test Files  979 passed | 175 skipped (1154)
     Tests  15891 passed | 1615 skipped (17506)      ← 零失败
```

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

### 6.1 CI 实测（Draft PR #5970，第一次提交 `718a54c2bd0ad1ca46c85f2aae1428e22e8efba3`）

| lane | 结果 | 它覆盖了本地哪条缺口 |
|---|---|---|
| `approval-realdb-l6a-roundscoping` | **pass** | **PostgreSQL 16**（容器）+ Node 20 + `pnpm install --frozen-lockfile` 的真实依赖树 —— 即 §7 第 1 条与 §1 表里 PG 版本差那一格 |
| main 分支保护要求的 13 条 required check（用 `gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.contexts[]'` 读出，不背数字） | 第一次提交时 **11 条 pass、`test (20.x)` 与 `test (18.x)` 红**（同一条单测，见 §4.5），其余 pass；该红已在本地复现并修掉，修复提交后的 CI 结果见 §6.2 | `test (20.x)` 就是 §4.5 说的默认无 DB lane |

**触发面已核对（§6 的表）**：l6a lane 在本 PR 上**确实被触发并执行**，不是 0 check 的假绿。

### 6.2 修复提交后的 CI

修复提交 `4b0650b96557001c82f718211c106389cc72e914`（§4.5 的单测隔离）push 后：

| 项 | 结果 |
|---|---|
| main 保护要求的 **13 条 required check**（逐条按 `gh api …/branches/main/protection` 的清单核对，不按数量） | **13/13 全部 reported 且 pass** |
| `test (20.x)` / `test (18.x)`（§4.5 打红过的那两条） | **success / success**；打红的那一步 "Run core-backend tests" 本身也是 `success` |
| `approval-realdb-l6a-roundscoping`（本 PR 的目标 lane，`postgres:16` + Node 20） | **pass** |
| PR 上全部 check | 52 pass / 1 skipping / 1 pending（`coverage`，非 required，且不是 fail） |

即 §7 第 1 条的 **PG 16 轴**与第 7 条的**默认无 DB lane**都由 CI 实际执行并通过 ——
两者都不是本地跑出来的，出处标在这里。

上表结果对应提交 `4b0650b96557001c82f718211c106389cc72e914` —— **本分支最后一次代码变更**；
在它之后本分支只有文档提交（零代码改动），所以这些结果对当前 head 的**代码**仍然成立。
**刻意不在此写当前 head 的 40 位 SHA**：那会让本节每加一次文档就作废一次（自指快照）。
读者要核对当前 head，用 `gh pr view 5970 --json headRefOid`。

PR 仍为 **Draft**。绿不等于被采纳：是否合并由 owner 决定，本代理未 undraft、未请求合并、未改任何锁文正文。

---

## 7. NOT RUN / 未声称（逐条）

1. **PostgreSQL 16 本地未跑。** 本地全部在 PG 15.17。本 PR 零 SQL 变更，理由上与版本无关，但**没有 16 的本地实测**。
   —— 该轴由 §6 的 CI（`postgres:16` 容器）覆盖，见那里的实测结果；本条保留是因为**本地**没有这条轴。
2. **并发/负载下的连接池压测未做。** 「持有审批连接的同时取第二条连接」在高并发下的池压力没有实测数字；
   设计 MD §7 R3 已按「既有形状的边际增量」记录，**「边际」二字无实测支撑**。
3. **R1（跨请求真并发乱序）未构造、未测、未修。** 本 PR 不声称关闭它。
4. **R2（`recordTerminal` 无作用域清空）未修、未构造反例。** 只做了可达性与危害有界的论证。
5. **未在本地自然复现**（不注入延迟）。本轮所有红都来自**确定性注入**；自然发生率仍只由 CI 侧观测
   （262 次 3 次 ≈1.1%，私有报告 §5）给出。本 PR 也**不**声称「把 1.1% 降到了 0」——
   可声称的是「被点名那条序列上的失败模式，在新实现下结构性不可达，且旧实现下确定性可复现」。
6. **未改测试夹具 `forceDeadlineOverdue` 的稳定性轮询。** 私有报告给 owner 的选项 (b) 未实施。
7. **apps/web 前端套件本地未跑**（本 PR 不碰前端；CI 的 `web-tests` required check 覆盖，结果见 §6.1）。
   默认（无 DB）lane **已在本地跑过**，见 §4.5 —— 那里同时记录了本 PR 在该 lane 上打红一条、
   本地复现、修复、重跑归零的全过程。本文第一版在这里写过一条站不住的免跑理由，已作废并留痕。

8. **未合并、未 undraft、未改锁文正文、未翻任何开关、未部署、未跑任何迁移到非一次性库。**

---

## 8. 资源

**已执行（过去式，不是预告）：**

- 临时延迟探针文件 `packages/core-backend/tests/integration/h1-latency-probe.test.ts`：本轮自建，
  §5 跑完后 `rm` 删除，**未进任何提交**（`git status --porcelain` 已复核）。
- 一次性库 `metasheet2_h1_20260922`：本轮多次 `dropdb` + `createdb -O ms2testbed`
  （每个批次前重建，不复用脏状态），每次建后 `psql -tAc "select current_database(), current_user"` 核过。
  owner `ms2testbed`（非超级）；`postgres` 超级用户**只**用于 `createdb` / `dropdb`。
- 两次源码回退（§3 的 mutation 与运行 D）均已用 `cp` / `cmp` 还原，还原后
  `git status --porcelain` 为空（= 工作树与提交逐字相同）。
- **未 kill 任何进程**（本轮没有起过跨命令存活的进程；期间观察到 peer 会话的 vitest 在跑，未触碰）。
- **未删任何不是本轮建的 worktree / 库 / 文件**；**未执行 `git worktree prune`**；**未用任何名字模式批量删除**。

**收尾步骤（在本文提交时尚未执行，交付后按名单逐项执行并登记）：**

- 点名全路径移除工作树 `…/6f6639a7-…/scratchpad/h1-timeout-race`；
  9 条 `node_modules` 软链逐条判 `-L` 再 `rm`（不递归穿过软链）。
- `dropdb -U postgres metasheet2_h1_20260922`。
- 备份目录 `…/scratchpad/h1-mutbak/`、`…/scratchpad/h1-fixbak/`（均为本轮自建）一并清理。
- 登记到 `~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/soak-working/resource-inventory-20260920.md`。

> 本节刻意把「已执行」与「收尾步骤」分栏：把还没做的清理写成已完成的记录，是一种伪造的证据。
