# H-1 验证 —— 审批节点超时效果 vs 异步 metrics 激活写入竞态

> **状态：PROPOSED（候选证据包，未裁决）。** 配套设计：
> `docs/development/h1-approval-node-timeout-activation-race-design-20260922.md`。
> 本文只记录**本轮实际执行过**的命令与其输出；没跑的一律进 §7 NOT RUN 清单。

- 分支：`fix/approval-node-timeout-effect-activation-race`
- 基线 / 分支点：`origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
- 变更文件：3 个（生产 1 + 集成测试 1 + 单元测试 1），**零迁移、零 DDL、零新错误码**

> **round-2（本轮）**：收口独立门审 `impl-gate-H1-activation-race-round1-20260922.md` 的
> P1-1 / P2-1 / P3-1 / P3-2。本轮**新增**的证据在 §3A（同节点探针 n=30 ×4 变体）、
> §3B（提交进套件的三向确定性控制）、§3C（2×7 逐站点 mutation）、§4.6（本轮全量跑）；
> §5 的延迟表被就地**缩小作用域**；§6.3 与 §7 第 9–15 条是本轮新增的 NOT RUN。
> **§3A 更正了 round-1 与门审共同持有的一个数字错误**：baseline 自己就会丢 arm（3/30），
> 不是「main 上 0/12」。round-1 的记录一律原样保留、只加标注，不改写。

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
| 连接串变量 | **被测代码只读 `DATABASE_URL`**（`src/integration/db/connection-pool.ts:226` 经 `secretManager.get('DATABASE_URL')` → `SecretManager.ts:19` `process.env[key]`；`migrate.ts` 走同一 `db`）。**round-2 勘误**：本行原写「全仓普查后无第二个」，那是错的 —— `.github/workflows/*.yml` + `package.json` 里共有 **6 个**连接串变量（见 §4.6），round-2 把**每一个**都 export 到一次性库 | 同名 | 每次运行前 `psql -tAc "select current_database(), current_user"` 核过 = `metasheet2_h1_20260922 \| ms2testbed`（round-1）／`metasheet2_h1fix_20260922`、`metasheet2_h1nb_20260922`（round-2） |
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
  （`getApprovalMetricsService()`，`ApprovalMetricsService.ts:1044`，`ApprovalProductService.ts:5328`
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

> **本节是 round-1 的实跑记录，原样保留**（它仍然成立：两条 round-1 用例在 baseline 上确定性红）。
> round-2 的证据在 §3A / §3B / §3C —— 那里也**更正**了 round-1 与门审共同持有的一个数字错误
> （「baseline 不会丢 arm」）。round-1 的整体 mutation（5 处一起回退）**无法区分每个站点**，
> 这个缺口由 §3C 的 2×7 逐站点格子关闭。

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

## 3A. round-2 —— 同节点再激活探针（n=30 ×4 个生产文件变体）

r1 门审报「baseline 12/12 正确、round-1 head 8/12 丢失、只恢复跳板 5/5 成功」。
**本轮用同一形状的探针把四个变体各跑 30 次**（一次性库、同一台机器、PG 15.17、Node v25.9.0，
每次都完整新建实例；读列的时机不是固定 sleep，而是把 `recordNodeDecision` / `recordNodeActivation`
包成**纯观察者**（同步转调原方法，只在完成时打点），等两者都 settle 后再读）：

模板形状（可发布，走真实 HTTP `POST /api/approval-templates` → `/publish` → `/api/approvals`）：

```
start → approval_a { approvalType: 'auto_approve' }
      → approval_c { assignee q, timeout{ afterMinutes:1, effect:'jump', jumpToNodeKey:'approval_a' } }
      → end
```

`approval_a` 在创建时自动通过 ⇒ 实例起始停在 `approval_c`；强制超期后
`applyNodeTimeoutEffect(id,'jump')` 跳回 A，A 再次被跳过 ⇒ 落回 `approval_c`，
即 `resolution.currentNodeKey === currentNodeKey`。

| 生产文件变体 | 再 arm 成功 | arm 丢失 | n | 观察到的交错 |
|---|---|---|---|---|
| baseline `cd42eaf74…` 的 blob（`git diff --stat` 零差异核过） | 27 | **3** | 30 | 27×`D-enter,A-enter,D-exit,A-exit`；3×`…A-exit,D-exit` |
| round-1 head `ad0a5a75…` | 8 | **22** | 30 | 8×`A-enter,D-enter,D-exit,A-exit`；22×`A-enter,D-enter,A-exit,D-exit` |
| 只恢复微任务跳板（门审的候选一行） | 19 | **11** | 30 | 19×`D-enter,A-enter,D-exit,A-exit`；11×`…A-exit,D-exit` |
| **本轮实现（跳板 + 两条路径 await decision 关闭）** | **30** | **0** | 30 | **30×`D-enter,D-exit,A-enter,A-exit`（单一交错）** |

**必须写下来的两条更正**（本文与门审的数字分歧，以本表为准，门审的 n=5 / n=12 被本表取代）：

1. **baseline 自己就丢 3/30**。门审的「main 上 0/12 出错」是小样本。所以这条缺陷**不是纯粹的
   round-1 回归**，round-1 把发生率从 ~10% 推到 ~73%；本 PR 也**不是**「恢复 main 的形状」，
   而是关闭一个 baseline 从未关闭的窗口。
2. **只恢复跳板仍丢 11/30**，比 baseline 差。跳板只把 decision 的派发提前一个微任务，
   两条事务随后仍在独立连接上竞争同一行的 `SELECT … FOR UPDATE`。
   **门审「判据是结果」的要求，跳板单独达不到**，这就是本轮同时 await decision 关闭的理由。

探针文件是本轮自建的一次性 vitest 文件，跑完已 `rm`、**未进任何提交**（§8）。

---

## 3B. round-2 —— 提交进套件的判别用例（三向控制，确定性）

`installLateDecisionClose(instanceId, nodeKey, 600ms)`（`approval-dedup-return-round-scoping.db.test.ts`）
是 `installLateActivationStamp` 的镜像：拦截**第一次**匹配 `(instanceId, nodeKey)` 的
`recordNodeDecision`，先 `await sleep(600)` 再委托原方法，完成后 resolve `landed`。
用例在 `applyNodeTimeoutEffect` / return 返回后**先等 `landed`**（可观测落库点，不是固定 sleep）
再读列，所以它不可能读到「关闭尚未落库」的快照而假绿。

为什么这样就双向确定：decision 被注入固定延迟后，**不 await 它的实现里激活写必然先跑**
（`added=false` ⇒ 跳过 deadline UPDATE），随后落库的关闭把两列置 NULL —— 确定性红；
**await 它的实现里激活写必然后跑**（`hasOpen` 为假 ⇒ `added=true` ⇒ 重新 arm）—— 确定性绿。

三向控制（整套件，每次新建库 + 重跑迁移；`cp` 备份 → `git show >` / `cp` 装入变体 → 跑 → `cp` 还原 → `cmp`）：

| 生产文件变体 | Node v25.9.0 | Node v20.20.2 | 红的是哪两条 |
|---|---|---|---|
| baseline `cd42eaf74…` 的 blob | `8 failed \| 8 passed (16)` | 未跑（见 §7） | 全部 8 条 H-1 用例 |
| round-1 head `ad0a5a75…`（= 旧实现正控） | `2 failed \| 14 passed (16)` | `2 failed \| 14 passed (16)` | `H-1 P1-1 GATE (timeout jump)` / `H-1 P1-1 GATE (return branch)` |
| 只恢复微任务跳板 | `2 failed \| 14 passed (16)` | `2 failed \| 14 passed (16)` | 同上两条 |
| **本轮实现** | `16 passed (16)` | `16 passed (16)` | — |

旧实现（round-1 head）下两条红的断言**逐字**：

```
× H-1 P1-1 GATE (timeout jump): a jump that resolves back to the SAME node re-arms its deadline and keeps its breakdown entry
  → re-activating the SAME node must re-arm its timeout effect, not leave it cleared by the decision close:
    expected null to be 'jump' // Object.is equality

× H-1 P1-1 GATE (return branch): a return that resolves back to the SAME node re-arms its deadline and keeps its breakdown entry
  → a return that lands back on the same node must re-arm its timeout effect:
    expected null to be 'jump' // Object.is equality
```

**其余 14 条在三个红的变体下全部保持绿** ⇒ 新增的两条 P1 用例是唯一对本轮改动有判别力的断言，
没有顺带打红别的东西（`feedback_confounded_mutation_needs_isolated_variant_grid`）。

**`:10688`（return 分支）的同节点场景本轮是构造出来并实测的，不是「与 `:9530` 同形状」的推断**：
门审明写它未复现；本轮用同一张图（返回目标 `approval_a` 是 `auto_approve`，级联落回 `approval_c`）
把它跑成了一条确定性用例。

---

## 3C. round-2 —— 逐站点 mutation（2×7 格，关闭 r1 门审 P2-1）

方法：每次只把**一行** `await this.` 机械替换成 `void this.`（`python3` 就地改一行，打印改后的行），
跑整文件，再 `cp` 还原并 `cmp` 核对。**全程未用 `git checkout --` / `reset --hard` / `stash`。**

| # | 站点（本轮 head 行号） | 所在方法 | 未 mutate | 单独 neuter 后 |
|---|---|---|---|---|
| 1 | `:8478` `emitNodeActivationMetric` | 管理员 jump | 绿 | **Failed Tests 1** —— `H-1 SITE (admin jump)` |
| 2 | `:9530` `settleNodeDecisionMetric` | `applyNodeTimeoutEffect` 决策关闭 | 绿 | **Failed Tests 1** —— `H-1 P1-1 GATE (timeout jump)` |
| 3 | `:9532` `emitNodeActivationMetric` | `applyNodeTimeoutEffect` 再激活 | 绿 | **Failed Tests 2** —— `H-1 SITE (timeout re-activation)` + `H-1 P1-1 GATE (timeout jump)` |
| 4 | `:10582` `emitNodeActivationMetric` | handler 分支 | 绿 | **Failed Tests 1** —— `H-1 SITE (handler branch)` |
| 5 | `:10688` `settleNodeDecisionMetric` | `return` 分支决策关闭 | 绿 | **Failed Tests 1** —— `H-1 P1-1 GATE (return branch)` |
| 6 | `:10690` `emitNodeActivationMetric` | `return` 分支再激活 | 绿 | **Failed Tests 1** —— `H-1 SITE (return branch)` |
| 7 | `:11264` `emitNodeActivationMetric` | 普通 approve/dispatch | 绿 | **Failed Tests 2** —— `H-1 DISCRIMINATOR` + `H-1 GATE` |

7 次 mutation 后的还原全部 `CMP_IDENTICAL`（脚本逐次打印）。

**交叉命中如实记，不声称「干净隔离」**：第 3 行与第 7 行各打红 2 条。
第 3 行的交叉是结构性的 —— `H-1 P1-1 GATE (timeout jump)` 在关闭落库后读列，
若再激活写不被等待，它读到的就是关闭刚置好的 NULL；第 7 行的两条本来就是 round-1 为同一站点写的一对。
关键结论是**每个站点都有至少一条用例对它有判别力**，round-1「4/5 站点可被 neuter 而全绿」的缺口已关闭。

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
不是 metrics 的落地顺序；注入 stub 后它对「是否 await」**没有**判别力。
**这句话是跑出来的，不是推出来的**：把生产文件还原成 `cd42eaf74…` 的 blob（`diff` 零差异，即**修复前**的实现），
**保留打过补丁的单测文件**，在无 DB 配置下重跑该文件 —— `Test Files 1 passed (1) / Tests 184 passed (184)`。
即它在修复前后都绿，确实不承载判别力。
判别力在 §3 的 C/D 两次回跑与 §2 的两条真库用例上，那两条在旧实现下是确定性红的。
metrics 写本身的覆盖也没丢：`tests/unit/approval-metrics-service.test.ts`（SQL 形状）+ 本 PR 新增的真库用例。

**修后本地重跑同一条 lane**：

```
Test Files  979 passed | 175 skipped (1154)
     Tests  15891 passed | 1615 skipped (17506)      ← 零失败
```

---

### 4.6 round-2 全量跑（本轮实现，一次性库 `metasheet2_h1fix_20260922` / `metasheet2_h1nb_20260922`）

| 跑什么 | 命令要点 | 结果 |
|---|---|---|
| 目标 lane 套件（与 workflow step 逐字同，除 `pnpm exec` → 直调 bin） | `CI=true EXPECT_DB=1 NODE_ENV=test vitest --config vitest.integration.config.ts run tests/integration/approval-dedup-return-round-scoping.db.test.ts --reporter=verbose` | **`Test Files 1 passed (1)` / `Tests 16 passed (16)`** |
| **稳定性 15 连跑**（同一套件，本轮用例内含延迟注入，同一次运行里另有 8 条**不**注入的用例） | 同上，`for i in $(seq 1 15)` | **15/15 全绿**（`Tests 16 passed (16)` ×15），零红、零间歇 |
| Node 20 轴（= CI 的 `node-version: 20.x` 大版本） | 同上，`PATH` 指向 `v20.20.2` | `Tests 16 passed (16)`；三向控制与 v25 逐条一致（§3B） |
| 邻居（仓内另外读写这两列 / 走被改路径的套件） | `approval-node-sla-remind` + `approval-node-timeout-effects` + `approval-handler-node.db` + `approval-sequential-mode.db` + `approval-metrics-people-teams`，**新建库 + 迁移** | **`Test Files 5 passed (5)` / `Tests 52 passed (52)`** |
| 默认（无 DB）lane = required `test (18.x)` / `test (20.x)` 的那一步 | `env -u DATABASE_URL -u ATTENDANCE_TEST_DATABASE_URL -u SMOKE_DATABASE_URL -u A_PROVISIONING_DB_URL -u A_RUNTIME_DB_URL -u PGDATABASE -u EXPECT_DB CI=true vitest run` | 退出码 0；**`Test Files 979 passed \| 176 skipped (1155)` / `Tests 15891 passed \| 1616 skipped (17507)`**，零失败 |
| 该 lane 上 round-1 曾打红的那个文件 | `vitest run tests/unit/approval-product-service.test.ts`（无 DB） | `Test Files 1 passed (1)` / `Tests 184 passed (184)` |
| `tsc`（src） | `tsc --noEmit -p tsconfig.json` | **退出码 0，零输出** |
| `tsc`（含本测试文件的一次性 config，因为仓库 `tsconfig.json` 的 `include` 不含 `tests/`） | `tsc --noEmit -p <tmp config>` | **退出码 0，该文件零诊断**；一次性 config 跑完即删 |

**连接串变量普查（本轮重做，不背 round-1 的结论）**：
`grep -rhno "[A-Z_]*DATABASE_URL\|PGDATABASE\|[A-Z_]*_DB_URL" .github/workflows/*.yml package.json packages/core-backend/package.json | sort -u`
⇒ 6 个：`A_PROVISIONING_DB_URL` / `A_RUNTIME_DB_URL` / `ATTENDANCE_TEST_DATABASE_URL` /
`DATABASE_URL` / `PGDATABASE` / `SMOKE_DATABASE_URL`。**每一个**都 export 指向本轮的一次性库；
每个库建好后 `psql -tAc "select current_database(), current_user"` 核过
（`metasheet2_h1fix_20260922 | ms2testbed`、`metasheet2_h1nb_20260922 | ms2testbed`）。
owner `ms2testbed`（非超级），`postgres` 超级用户**只**用于 `createdb` / `dropdb`。
`metasheet_test` / `metasheet_v2` / `metasheet_testbed_*` 全程零引用。

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

> **round-2 作用域更正（重要）**：上表测的是 **approve/dispatch 路径**
> （`POST /api/approvals/:id/actions` 的 approve），而 approve 路径上 round-2 **没有**新增任何 await
> （它的决策关闭仍是 fire-and-forget）。**round-2 真正变慢的两条路径 —— `applyNodeTimeoutEffect`
> 与 `return` 分支 —— 没有延迟数字**，因为本轮没有为它们重做这个探针。
> 可以从结构上说的只有：那两条路径在响应前多等**一个 hook**，而每个被 await 的 hook 最多是
> **两次顺序 checkout**（`mutateBreakdown` 的多语句取锁事务 + 其后独立的单语句 `UPDATE`），
> 所以这两条路径最多是 `C1 + 4 次顺序 checkout`（设计 MD §5 表末两行已逐个数过）。
> `connectionTimeoutMillis = 10000` / `statement_timeout = 30000` 是**每次 checkout / 每条语句**的上界，
> 不是整条路径的上界（设计 MD §7 R5）。
> **这是一条 NOT RUN，见 §7 第 9 条。**

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
在它之后本分支只有文档提交，所以这些结果对当前 head 的**代码**仍然成立。
这一点是**可机械核验**的，不是断言 —— `git diff --stat 4b0650b96557001c82f718211c106389cc72e914..<当前 head>`
的输出只含 `docs/` 路径（零 `packages/` / 零 `.github/` 条目）。
**刻意不在此写当前 head 的 40 位 SHA**：那会让本节每加一次文档就作废一次（自指快照）。
读者要核对当前 head，用 `gh pr view 5970 --json headRefOid`。

PR 仍为 **Draft**。绿不等于被采纳：是否合并由 owner 决定，本代理未 undraft、未请求合并、未改任何锁文正文。

### 6.3 round-2 的 CI

§6.1 / §6.2 记的是**代码提交 `4b0650b96557001c82f718211c106389cc72e914`（round-1）** 的结果 ——
**不要把它读成本轮的结果**。

round-2 的第一个提交 **`b8b92261907f662725337da4355457c548073b82`** push 后：

| 项 | 结果（`gh pr checks 5970`，不背数字） |
|---|---|
| `approval-realdb-l6a-roundscoping`（本 PR 的目标 lane，`postgres:16` + Node 20 + `pnpm install --frozen-lockfile`） | **pass**（1m37s）—— 即本地缺的 PG 16 轴与真实依赖树那两格 |
| 当时已结算的其余全部 check | 全 pass，零 fail（`test (18.x)` / `test (20.x)` / `web-tests` 三条当时仍 pending） |

本文最终提交对应的 head **在此之后**（本节这段更正 + 生产文件里一条注释的措辞收紧 + §5/R3 的
checkout 计数更正），它会重新触发同一批 lane。**本文不预告那次运行的结果**：读者以
`gh pr checks 5970` 为准。触发面不变（改的文件都在 l6a lane 的 `paths:` 里，见 §6 的表），
未新增测试文件、未改 `plugin-tests.yml`、未改 `vitest.config.ts` 的 `exclude`
⇒ 仍不触发 s6a pin / W7-R10 分类 / CI corpus 的任何一钉。

main 分支保护的 required 清单请用
`gh api repos/zensgit/metasheet2/branches/main/protection --jq '.required_status_checks.contexts[]'`
现读（本轮读到 **13 条**），不要背这个数字。

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

**round-2 追加的 NOT RUN（逐条）**

9. **两条变慢路径（`applyNodeTimeoutEffect` / `return`）的延迟没有数字。** §5 的表测的是 approve 路径，
   而 approve 路径本轮零新增 await —— 那张表**不覆盖**本轮的代价，已就地标注。
10. **round-2 自己的 CI 未跑**（§6.3）。§6.1 / §6.2 的 13/13 与 l6a pass 属于 round-1 的代码提交
    `4b0650b96557001c82f718211c106389cc72e914`，**不能**当成本轮 head 的结果。
11. **baseline blob 的整套件跑只做了 Node v25.9.0 一轴**（`8 failed | 8 passed`）。
    round-1 head 与「只恢复跳板」两个变体在 v25.9.0 与 v20.20.2 **两轴都跑了**。
12. **同节点探针只在 PG 15.17 上跑**（n=30 ×4 变体）。PG 16 轴本地仍未跑。
13. **R1（真并发跨请求乱序）仍未构造、未测、未修**；R2（`recordTerminal` 无作用域清空）同上；
    R5（被 await 的 hook 把 metrics 停顿引入响应时延）是本轮**新增并披露**的残留，未做压测。
14. **未对 `:10808`（sequential 模式节点内队首推进）构造任何用例。** r1 门审在「观察」里点出
    该处提交后对**仍停在同一节点**的实例发出 `emitNodeDecisionMetric`，其作用域清空守卫为真、
    会把进行中节点的 deadline 清掉。那是 baseline 既有、不在本 PR 的 diff 里、**本轮同样未构造复现**，
    只在此登记以免被当成已处理。
15. **apps/web 前端套件本轮未跑**（本 PR 不碰前端）。

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

### 8.1 round-2 的资源（同样分栏）

**已执行（过去式）：**

- 一次性 worktree `…/6f6639a7-…/scratchpad/h1-fix`（`git worktree add --detach`，
  起点 = round-1 head `ad0a5a75d6e14dbc5aa56bb1819418c257ac2a4a`），`node_modules` 从 canonical
  软链 9 条（根 / apps/web / packages/core-backend / plugins/* 6 条）。
- 一次性库 **`metasheet2_h1fix_20260922`**（探针、三向控制、逐站点 mutation、15 连跑、Node 20 轴）
  与 **`metasheet2_h1nb_20260922`**（邻居批次），owner `ms2testbed`（非超级），
  `postgres` 超级用户只用于 `createdb` / `dropdb`，建后逐个 `psql` 核过 `current_database()`。
- 临时探针文件 `packages/core-backend/tests/integration/h1-samenode-probe.db.test.ts`：本轮自建，
  §3A 跑完后 `rm`，**未进任何提交**（`git status --porcelain` 已复核）。
- 一次性 `tsconfig.h1tests.json`：跑完即删。
- 源码变体切换全部走 `cp` 备份 / `git show <sha>:<path> >` 装入 + `cp` 还原 + `cmp` 核对
  （备份目录 `…/scratchpad/h1-bak/`，本轮自建）。**全程未用 `git checkout --` / `reset --hard` / `stash`。**
- **未 kill 任何进程**；**未删任何不是本轮建的 worktree / 库 / 文件**；**未执行 `git worktree prune`**；
  **未用任何名字模式批量删除**。

**收尾步骤（本文提交时尚未执行，交付后按名单逐项执行并登记）：**

- 点名全路径移除工作树 `…/6f6639a7-…/scratchpad/h1-fix`（9 条 `node_modules` 软链逐条判 `-L` 再处理）。
- `dropdb -U postgres metasheet2_h1fix_20260922` 与 `dropdb -U postgres metasheet2_h1nb_20260922`。
- 备份目录 `…/scratchpad/h1-bak/` 清理。
- 登记到 `~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/soak-working/resource-inventory-20260920.md`。

---

## 附录 D — P3-B 行号锚点重生成记录（D1 记录修复轮，2026-09-22）

**触发原因**：本轮 P3-A 在 `ApprovalProductService.ts` 的 JSDoc 里删除 2 行（两句被 r1 证否的论证），
P3-C 在 `settleMetricsCall` 的跳板注释里删除 4 行换成 2 行（净 -4 行）；两处编辑都在文件前部，
使其后所有行号整体下移 —— 原 `:239` 起的内容下移 4 行，原 `:11343`（`private emitNodeActivationMetric(` 的原位置）
起的内容累计下移 6 行。设计 MD / 验证 MD 里所有指向 `ApprovalProductService.ts` 且原行号 ≥ 239 的锚点，
连同 r1 遗留、本轮之前就已存在的「+45 漂移」三处定义锚点（`emitApprovalTaskCreatedEventsPostCommit` /
`supersedeCardDeliveriesPostCommit` / `bumpNodeActivationSeq`），以及另外新发现的、与本轮编辑无关的
历史性错锚（`ApprovalProductService.ts` 构造函数行、`connection-pool.ts` 的 `DATABASE_URL` 读取行与
`connectionTimeoutMillis` 等配置项跨度、`settleNodeDecisionMetric`/`nodeDecisionMetricWrite` 定义行、
`applyNodeTimeoutEffect` 竞态守卫跨度、`consumeTimeout` 定义跨度、跨请求窗口注释行），全部按下表重新核验。

**方法**：对每个锚点，用 `grep -n '<唯一上下文文本>' <本轮 worktree 内文件>` 取本轮 head
（提交 `b273f5746` + 本轮未提交的 P3-A/P3-C 编辑）上的真实行号；跨度锚点（`AA-BB`）另用
`sed -n 'AA,BBp' <file>` 核对首尾行内容与文中描述一致。以下为关键命令与其真实输出（本会话原样执行）。

### D.1 — 编辑后关键定义行（`grep -n`，本轮 head）

```
$ grep -n "private emitNodeActivationMetric(\|private settleNodeDecisionMetric(\|private nodeDecisionMetricWrite(\|private async emitApprovalTaskCreatedEventsPostCommit\|private async supersedeCardDeliveriesPostCommit\|private async bumpNodeActivationSeq\|class ApprovalProductService\|constructor(private readonly metrics" packages/core-backend/src/services/ApprovalProductService.ts
5323:export class ApprovalProductService {
5328:  constructor(private readonly metrics: ApprovalMetricsService = getApprovalMetricsService()) {}
11311:  private settleNodeDecisionMetric(instanceId: string, nodeKey: string, actorId: string): Promise<void> {
11316:  private nodeDecisionMetricWrite(instanceId: string, nodeKey: string, actorId: string): () => Promise<void> {
11337:  private emitNodeActivationMetric(
11886:  private async emitApprovalTaskCreatedEventsPostCommit(
11944:  private async supersedeCardDeliveriesPostCommit(instanceId: string, excludeId?: string): Promise<void> {
11961:  private async bumpNodeActivationSeq(
```

### D.2 — 7 个被 await 的 hook 调用点 + 各自前置 COMMIT（`awk`，本轮 head）

```
$ awk 'NR>=8400 && NR<=11300 && /emitNodeActivationMetric\(|emitNodeDecisionMetric\(|settleNodeDecisionMetric\(|query\(.COMMIT.\)|emitTerminalMetric\(/ {print NR": "$0}' packages/core-backend/src/services/ApprovalProductService.ts
8460:       await client.query('COMMIT')
8478:         await this.emitNodeActivationMetric(id, resolution.currentNodeKey, resolveCalendarSlaOrgId(toNullableRecord(instance.requester_snapshot)), nodeTimeoutForKey(runtimeGraph, resolution.currentNodeKey))
8771:         await client.query('COMMIT')
9026:           await client.query('COMMIT')
9070:           await client.query('COMMIT')
9114:           await client.query('COMMIT')
9185:         await client.query('COMMIT')
9236:         await client!.query('COMMIT')
9256:         await client.query('COMMIT')
9280:           await client.query('COMMIT')
9396:         await client.query('COMMIT')
9522:       await client.query('COMMIT')
9530:       await this.settleNodeDecisionMetric(id, currentNodeKey, APPROVAL_TIMEOUT_SYSTEM_ACTOR)
9532:         await this.emitNodeActivationMetric(id, resolution.currentNodeKey, resolveCalendarSlaOrgId(toNullableRecord(instance.requester_snapshot)), nodeTimeoutForKey(runtimeGraph, resolution.currentNodeKey))
9825:           await client.query('COMMIT')
10027:         await client.query('COMMIT')
10061:         await client.query('COMMIT')
10121:         await client.query('COMMIT')
10189:         await client.query('COMMIT')
10268:         await client.query('COMMIT')
10270:         this.emitTerminalMetric(id, 'revoked')
10454:           await client.query('COMMIT')
10572:         await client.query('COMMIT')
10579:           this.emitTerminalMetric(id, 'approved')
10582:           await this.emitNodeActivationMetric(
10681:         await client.query('COMMIT')
10688:         await this.settleNodeDecisionMetric(id, currentNodeKey, actor.userId)
10690:           await this.emitNodeActivationMetric(id, resolution.currentNodeKey, resolveCalendarSlaOrgId(toNullableRecord(instance.requester_snapshot)), nodeTimeoutForKey(runtimeGraph, resolution.currentNodeKey))
10737:         await client.query('COMMIT')
10738:         this.emitNodeDecisionMetric(id, currentNodeKey, actor.userId)
10740:         this.emitTerminalMetric(id, 'rejected')
10806:           await client.query('COMMIT')
10808:           this.emitNodeDecisionMetric(id, currentNodeKey, actor.userId)
10841:           await client.query('COMMIT')
10987:           await client.query('COMMIT')
11241:       await client.query('COMMIT')
11259:       this.emitNodeDecisionMetric(id, currentNodeKey, actor.userId)
11262:         this.emitTerminalMetric(id, 'approved')
11264:         await this.emitNodeActivationMetric(id, resolution.currentNodeKey, resolveCalendarSlaOrgId(toNullableRecord(instance.requester_snapshot)), nodeTimeoutForKey(runtimeGraph, resolution.currentNodeKey))
11284:   private emitNodeDecisionMetric(instanceId: string, nodeKey: string, actorId: string): void {
```

### D.3 — 其余分散锚点（`grep -n` / `sed -n`，本轮 head）

```
$ grep -n "recordInstanceStart(\|The armed deadline no longer matches\|const consumeTimeout = async\|SET current_node_deadline_at = NULL, current_node_timeout_effect = NULL\|armedResult = await client.query\|armed.current_node_timeout_effect !== scannedEffect" packages/core-backend/src/services/ApprovalProductService.ts
8158:    safeMetricsCall(`recordInstanceStart(${instanceId})`, async () => {
8174:      await this.metrics.recordInstanceStart({
9226:      const consumeTimeout = async (): Promise<void> => {
9229:             SET current_node_deadline_at = NULL, current_node_timeout_effect = NULL
9261:      const armedResult = await client.query<{ current_node_deadline_at: string | Date | null; current_node_timeout_effect: string | null }>(
9267:      if (!armed || Number.isNaN(deadlineMs) || deadlineMs > Date.now() || armed.current_node_timeout_effect !== scannedEffect) {
9307:        // The armed deadline no longer matches the current node's configured effect (e.g. the
```

```
$ grep -n "DATABASE_URL\|connectionTimeoutMillis\|DB_POOL_MAX\|statement_timeout\|query_timeout" packages/core-backend/src/integration/db/connection-pool.ts
17:  query_timeout?: number
18:  statement_timeout?: number
136:      queryConfig.query_timeout = Math.floor(timeoutMs)
137:      queryConfig.statement_timeout = Math.floor(timeoutMs)
226:    const connectionString = secretManager.get('DATABASE_URL', { required: process.env.NODE_ENV === 'production' })
228:      this.logger.warn('DATABASE_URL not set; database pool will use driver defaults and may fail to connect')
248:        max: parseInt(process.env.DB_POOL_MAX || '20', 10), // 最大连接数
253:        connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '10000', 10), // 连接超时
260:        query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT || '30000', 10), // 查询超时
261:        statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10), // 语句超时
```

**核对方法说明（本轮的一处自纠）**：`:9312`（原 head，跨请求窗口注释）第一遍按整段注释的第二行
折算得到 `:9308`，随后用 `sed -n '9304,9315p'` 逐行核对时发现注释首行实际在 `:9307`
（`// The armed deadline no longer matches …`），已改用 `:9307` 覆盖前一遍的 `:9308`，
以此提醒：本表全部数字均以 D.1–D.3 的 `grep -n` / `sed -n` 输出为准，不做二次心算折算。

### D.4 — 修正对照表（旧锚点 → 本轮 head 真值；旧值为编辑前 MD 原文，含 r1 遗留漂移与另外发现的历史错锚）

| 内容 | 旧锚点（MD 原文） | 本轮 head 真值 |
|---|---|---|
| 管理员 jump 前置 COMMIT | `:8464` | `:8460` |
| 管理员 jump activation | `:8482` | `:8478` |
| `recordInstanceStart` 的 `safeMetricsCall` | `:8162` | `:8158` |
| T1-1 「FIRST node activated」注释 | `:8163` | `:8159` |
| `consumeTimeout` 定义跨度 | `:9230-9236` | `:9226-9232` |
| `consumeTimeout` 置 NULL 语句行 | `:9233`（本轮 head，旧文写法） | `:9229` |
| 事务内竞态守卫跨度 | `:9265-9271` | `:9261-9267` |
| 跨请求窗口注释（R1，未关闭） | `:9312` | `:9307` |
| `applyNodeTimeoutEffect` 决策关闭（GATE/SITE 表） | `:9534` | `:9530` |
| `applyNodeTimeoutEffect` 再激活（SITE 表） | `:9536` | `:9532` |
| timeout-jump 前置 COMMIT | `:9526` | `:9522` |
| handler 分支前置 COMMIT | `:10576` | `:10572` |
| handler 分支 `emitTerminalMetric('approved')` | `:10574`（旧文与另一条混用） | `:10579` |
| handler 分支 activation | `:10586` | `:10582` |
| return 分支前置 COMMIT | `:10685` | `:10681` |
| return 分支决策关闭（GATE 表） | `:10690`（与下行旧文互相指错） | `:10688` |
| return 分支 activation（SITE 表） | `:10692` / `:10694`（两处旧文不一致） | `:10690` |
| reject 分支 `emitNodeDecisionMetric`（fire-and-forget） | `:10740` | `:10738` |
| sequential 队首推进 `emitNodeDecisionMetric` | `:10810` | `:10808` |
| approve 前置 COMMIT | `:11243` / `:11245`（两处旧文不一致） | `:11241` |
| approve `emitNodeDecisionMetric`（fire-and-forget） | `:11261` | `:11259` |
| approve `emitTerminalMetric('approved')`（此前被 SITE 表误当 activation） | `:11252` / `:11266` | `:11262` |
| approve activation（DISCRIMINATOR/GATE/SITE 表） | `:11266` / `:11268`（两处旧文不一致） | `:11264` |
| `settleNodeDecisionMetric` 定义 | `:11313` | `:11311` |
| `nodeDecisionMetricWrite` 定义 | `:11318` | `:11316` |
| `emitNodeActivationMetric` 定义（签名行） | `:11341` | `:11337` |
| `emitApprovalTaskCreatedEventsPostCommit` 定义（r1 遗留 +45 漂移之一） | `:11847` | `:11886` |
| `supersedeCardDeliveriesPostCommit` 定义（r1 遗留 +45 漂移之一） | `:11905` | `:11944` |
| `supersedeCardDeliveriesPostCommit` 无条件调用点 | `:11245`（与前置 COMMIT 旧文混用同一数字） | `:11255` |
| `bumpNodeActivationSeq` 定义（r1 遗留 +45 漂移之一） | `:11922` | `:11961` |
| 构造函数（`getApprovalMetricsService()` 默认参数） | `ApprovalProductService.ts:5296` | `:5328` |
| `connection-pool.ts` 的 `secretManager.get('DATABASE_URL')` | `connection-pool.ts:200` | `:226` |
| `connection-pool.ts` 的 `connectionTimeoutMillis`/`DB_POOL_MAX`/`statement_timeout` 跨度 | `connection-pool.ts:252-258` | `:248-261` |

**未改动的锚点（逐条核过，命中即确认，未列入 D.4）**：`:201`/`:210`/`:231`（早于两处编辑，行号不变）；
`ApprovalMetricsService.ts` 全部锚点（该文件本 PR 一行未改：`:247`/`:317`/`:440`/`:458-471`/`:468`/
`:481-489`/`:493-499`/`:496`/`:1019-1040`/`:1044`）；`SecretManager.ts:19`；测试文件
`approval-dedup-return-round-scoping.db.test.ts` 的 `:696`/`:709`/`:788`/`:824`（该文件本轮未改动，
`diff` 对 `b273f5746` 为空）；`ApprovalMetricsService.ts:440` 先例引用（design MD §5 行 179）。
`:482`（design MD §1 引用的历史 CI 失败输出逐字转录）与 `:903`（verification MD 引用的历史 CI 失败输出逐字转录）
是对已发生事件的原样引用，不是指向本轮 head 的活锚点，未重算。`:5432` 为示例 `DATABASE_URL` 里的
PostgreSQL 端口号，不是行号，未列入。

> 本附录由 `grep -n` / `sed -n` 的真实输出生成，不含手工心算的行号；表中数字与本轮提交里
> 设计 MD、验证 MD 正文的修改逐一对应。
