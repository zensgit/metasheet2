# 备料 persist 原子性（P4）— 设计锁（PROPOSED — owner ratification required）— 2026-07-17

> **状态：PROPOSED。本文是四类方案的比较与验证设计，不是裁决。**
> 依 T3b 锁 OD-4（`stock-preparation-t3b-plm-source-autopersist-design-lock-20260716.md:248-249`）：
> autopersist 生产常开保持 barred，直到独立 P4 完成**事务 / 两阶段状态 / repair protocol**
> 之一并有 crash-injection 证据，或 **owner 另行书面接受该有界风险**。本文逐一展开这四类方案，
> 给出对比矩阵与最低验证门；**推荐仅为倾向，最终选型留 owner ratify。**
> 本文不改任何运行时代码，不影响 RC-A（#4437）的 exact 包 SHA（`d87e086fd1…`）。
> 全部代码事实以 origin/main `9048c27e2` 为锚（file:line 均指该 ref）。

## 0. 问题域：现状事实（均已对代码核实）

### 0.1 写序与事务粒度

`persistStockPreparationSyncRun`（`plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs`）
是 **4 表顺序 create 路径**，经 `context.api.multitable.records`（in-process，无 HTTP）：

1. admin 门 + provisioning 检查（:407-411）→ plan 重算（纯，:415）→ 解析 4 个 scoped sheet（:449-452）；
2. **batch-key 幂等预检**（limit 2 查询，:457-461）→ **project-key 预检**（:469，`queryProjectRows` :246-260）；
3. 命中已有 batch → `assertExactReplay`（:292-334）→ 200 skip 或 409；否则 create 路径：
4. **create batch**（:493）→ **逐行 create line**（循环，:495-498）→ **create run**（:499）→
   **project upsert 最后**（:505-513；`upsertStockPreparationProject` :341-366——create :353 或
   仅 patch `lastSyncRunId/lastSyncedAt/projectStatus` :357-364）。

**每次 `createRecord`/`patchRecord` 是它自己的一个 poolManager 事务**（`packages/core-backend/src/index.ts:595-596`
create、:633-634 patch；`queryRecords` 是普通池查询 :573-585）。跨写**没有共享事务**：plugin API 面只收
`{sheetId, data}`，**无任何事务/client 传递参数**（`packages/core-backend/src/types/plugin.ts:436-504`，
`MultitableRecordsAPI` 共 6 个单记录方法，无 bulk/batch/unit-of-work）。崩溃只会落在整行提交之间，
部分状态永远是「整数个完整行」。

存储面：`meta_records` 每记录一行，全逻辑字段在 `data` jsonb 里，PK 只有 `id`
（`rec_${randomUUID()}`），**逻辑键上没有任何唯一约束**（DDL
`zzz20251231_create_meta_schema.ts:44-51`；索引全部非唯一，含 GIN(data)，
`zzzz20260413110000_add_meta_records_query_indexes.ts:12-15`）。`snapshotBatchId` 唯一性**只靠**
persist 模块的 limit-2 预检 + 409。

### 0.2 崩溃窗口 CW1-CW5

| 窗口 | 崩溃点 | 库内残留 | retry 观测（#4382 后） |
|---|---|---|---|
| CW1 | batch 后、首行 line 前 | 仅 batch 行 | 409 `PERSIST_EXISTING_BATCH_INCOMPLETE` `{run,missing}` |
| CW2(k) | line 循环中 | batch + k 行完整 line（1≤k<N），无 run | 同上 `{run,missing}` |
| CW3 | 全部 line 后、run 前 | batch + N line，无 run | 同上 `{run,missing}` |
| CW4-first | run 后、project create 前（首次 sync） | batch+lines+run，**无 project 行** | 409 `{project,missing}`（:332） |
| **CW4-existing** | run 后、project patch 前（项目已存在） | batch+lines+run 完整；**project 指针 stale**（`lastSyncRunId` 仍指旧 run） | **200 `skipped_existing`——静默**。replay 只查 project **存在性**（:332），不校验指针内容；replay 分支零写（:471-487），模块「never repairs or patches snapshots」（:455-456） |
| CW5 | project upsert 后、响应前 | 库一致 | 200 `skipped_existing`（正常） |

要点：
- **CW1-CW3 的 retry 观测同型**：`assertExactReplay` 先查 run（:305-310）后查 line（:315-330），
  run 缺失掩蔽 line 缺失；`{snapshot_line,missing}` 分支（:326）按写序**不可能由崩溃触达**（只有外部
  删除触达）——非缺陷，但验证设计须知道这条分支的真实触达面。
- **CW4-existing 是唯一静默退化窗口**：无 409、无徽标、无修复路径，该 run 永久脱离 project 指针。
- batch 先行是有意设计（:490-492 注释：崩溃在 retry 时显式 409，绝不重复/静默 skip）——本锁不推翻
  该次序，只处理它留下的孤儿与静默窗口。

### 0.3 并发写（TOCTOU，无锁跨越 check-then-create）

- **同 batchId 双写**：存在性查询（:457）与 create（:493）间无锁（唯一的锁是每次 createRecord 内部
  per-sheet `pg_advisory_xact_lock`，随该单行提交释放——序列化的是单行插入，不是 check-then-create；
  `canonical-sheet-fence.ts:82`、`records.ts:612`）。双写者都可见 length===0、各自完整提交
  → 之后**所有** replay 见 `existingBatch.length>1` → 409 `PERSIST_IDEMPOTENCY_CONFLICT`
  `duplicate_key`（:465）**永久毒化该 key**，无修复路径。
- **同 project 异 batch 首写竞态**：project 预检在最早（:469），create-vs-patch 决策在最后（:505），
  TOCTOU 跨越整个 persist。双首写各 create 一条 project 行 → `queryProjectRows` 见 2 行 →
  该**项目整体毒化**为 409 `{project,duplicate_key}`（:255）。已存在 project 行的 patch-vs-patch
  竞态则被行内 fence 序列化（`records.ts:491-546`，patch 无 expectedVersion 但 fence 先于读）。
- 底座**乐于**插入两条同逻辑键的行（INSERT 无 ON CONFLICT，:627-632；无唯一索引）——
  **即便有跨写事务，并发重复窗口也不闭合**，须另配 key 级锁或唯一表达式索引（见 §3）。

### 0.4 读侧可见性（消费端逐一核实）

- **view-2 批次列表**：按 `{projectId}` 全量查（无 status 过滤），`incomplete = lineCount===0 ||
  run 行缺失`（`stock-preparation-snapshot-reads.cjs:204`）；staged/孤儿行**会返回**（打徽标）。
- **diff 端点服务端无完整性门**：current/base 都不查完整性——孤儿可当 current（静默半截 diff）也可当
  base（0-line 孤儿 → 幻造全 added diff）；auto predecessor 只按版本号（:270-291），#4019
  explicit-pair 四检不含完整性（:293-320）。**只有 FE** 禁用按钮
  （`StockPreparationSnapshotDiffView.vue:124-127`）。
- **confirm/generation fail-closed**：结构完整性判定（run 行在 + line 非空），显式 batchId 不完整
  → 409 `CONFIRM_BATCH_INCOMPLETE` / `GENERATION_BATCH_INCOMPLETE`；auto-pick **跳过**不完整批次
  （最新批次是孤儿时**静默改选旧批次**）。孤儿永不进入 candidates/prep-line 生成。
- **读写谓词不对称**：读侧 incomplete 不含 project 行检查，persist replay 含（:332）——CW4-first 在
  view-2 显示**完整**、generation 接受，但 persist retry 409，且 view-1 项目列表根本不出现该项目
  （project 行最后写；view-1 是 UI 唯一入口，孤儿只能靠 `?projectId=` 深链触达，
  `stock-preparation-project-reads.cjs:196-232`）。
- **dashboard**：一个孤儿即令 `sync_incomplete_batches` 成为推荐下一步（`stageOverview.ts:219-224`）。

### 0.5 状态词表现状（owner 前提确认）

词表**没有 `pending`**：`snapshot_status ∈ {draft, active, superseded, rejected}`
（`stock-preparation-sync-run-plan.cjs:36,42`；契约 optionSource key
`stock_preparation_snapshot_status_v1`，`stock-preparation-templates.cjs:633-634`），写入方**只写
`draft` 且永不翻转**（:303 注释「status draft, never active」）——完整提交与崩溃孤儿在状态上
**不可区分**，完整性只能结构性证明（run 行 + 完整 line 集 + project 行），这正是
`assertExactReplay` 的算法。run status ∈ {running, succeeded, failed, partial}；prep-line 实际词表只有
{draft, held}。**没有任何 reader 按 `snapshotStatus` 过滤**（全仓唯一消费点是 :199 的原样回显）。

### 0.6 错误面与调用方

- 中途底座失败 → 无 `.status` 的异常 → 500 `INTERNAL_ERROR`（`http-routes.cjs:432-453`），
  **不泄露 partial counters / identity**（`linesCreated` 是局部变量，仅进成功返回 :515）。
- 生产调用方恰两个，共享同一模块：`POST /mvp/sync/persist`（:3887-3915）与 T3b flag-gated
  source-run 桥（:3982，默认 OFF）。T3a ERP 走**兄弟模块** `erp-material-sync-persist.cjs`
  （upsert-by-key 语义，不在本锁范围，见 §10）。apps/ 无前端调用方。

## 1. 继承的权威约束（不重开已裁决项）

- **快照不可变**：batch/line/run 创建后不 patch；project 是 live pointer，仅按既有 contract upsert
  （T3b OD-4；persist 模块头 :26-31）。
- **replay 语义已硬化（#4382，已合并，不属本锁改动面）**：孤儿 retry = 409（非 false skip）；
  同 id 异内容 = 409 `content_mismatch`；判等 = 冻结模板全投影（`frozenProjection` :186-204，
  **含 `snapshotStatus`**——对方案 B 是硬约束，见 §4）。
- **values-free**：新增状态、错误、修复动作的公开面不得含 partial counters / identity / 业务值。
- **外部写零授权**：本锁与外部写无关，`externalWrite=false` 姿态不变。
- **W6/T4 smoke 现有断言**（`stock-preparation-mvp-postdeploy-smoke.mjs:630-700`、
  `prep-line-extended-smoke.mjs:281-309,485-496`）：201 created→200 skipped_existing 幂等对、
  batchCount===1、incomplete===false、teardown 视 batch/lines/prep-lines/exceptions 为
  **immutable audit substrate**。任何方案落地时这些断言是回归面。

## 2. 方案定义域

OD-4 允许的四类。每类先给最小诚实形态，再给覆盖/残留。

## 3. 方案 A — 事务（host 侧组合原语）

**形态**（最小、尊重分层）：`records.ts` 的存储函数**已经是事务不可知的**（接受注入的 query fn，
:598-601；host 在构建 CoreAPI 时选边界）。故 A = 在 host 侧新增**一个**组合 API（如
`records.createRecordsAtomic([{sheetId,data},…])` 或备料专用 composite），实现为**单个**
`poolManager.get().transaction`，内部以共享 tx query 复用既有 `createMultitableRecord` N 次——
**revision 发射与 auto-number 自动保持正确**（它们键在传入的 query 上，同事务提交）。改动面三文件：
`types/plugin.ts`、`index.ts`、`plugin-scope.ts`（逐 sheetId scope 断言）+ persist 模块采用。

**先例**（同架构形状已在仓内）：
- `provisioning.ensureObjectInScope`：单个 plugin 调用背后的 host 侧一事务多写组合
  （`index.ts:1448-1480`）；
- kernel `RecordWriteService.patchRecords`：一次 bulk 多记录 patch = 一个 mutation 事务
  （`record-write-service.ts:677-685,985-1000`）——底座支持多记录原子写，只是未经 plugin SDK 暴露。

**必须同时解决的并发闭合**（事务**不**闭合 §0.3 的重复窗口）：组合事务内先取
`pg_advisory_xact_lock(hash(sheetId|snapshotBatchId))` 与 `hash(sheetId|projectId)`（**固定获取次序**，
排在 4 张表的 per-sheet fence 之前，见下）再复检存在性、再写——锁随 COMMIT 释放，
check-then-create 原子化，同 batch 双写与 project 首写竞态都收敛为「一胜一 skip/409」。
（替代：`(sheet_id, data->>'snapshotBatchId')` 部分唯一表达式索引——影响面跨所有含该字段名的
sheet，治理成本更高，仅作备选记录。）

**代价（真实成本，须写进验收）**：
- 组合事务持有至多 4 张 sheet 的 advisory xact lock 直至 COMMIT（`auto-number-service.ts:23-31`
  per-create fence）——**锁获取次序必须固定**（如按 objectId 字典序），否则与其他写者可成环死锁；
- 行循环上界大（read bound 500×50 = 至多 25,000 行，persist.cjs:77-78）→ 单长事务；须裁量行数上限
  或分段策略（分段则回到部分可见，须在锁文里显式取舍——建议 v1 直接沿用现有 plan 规模上限并压测）；
- flag-gated `assertNoActiveWriterBlock` 每 create 跑一次（:612-614），事务内语义不变但持锁时长增加；
- kernel API 面新增 = 跨插件契约，需 W0 canonical fence 相容性审（组合内逐行 revision 发射同事务，
  初判相容，须在验证里证明）。

**覆盖**：CW1-CW4 全闭（单提交点，中途失败=全回滚，零残留）；CW4-existing 的 project patch 进事务
→ stale 指针窗口闭合；TOCTOU 毒化闭合（in-tx 锁）。**残留**：存量孤儿/毒化行不自愈（一次性清理归
方案 C 的工具形态或 owner 手工，见 §5）；`assertExactReplay` 全套保留为纵深防御。

## 4. 方案 B — 两阶段状态（staged → committed 标记）

**形态**：沿用现写序，把「提交完成」显式化为一个终笔标记。表示法三选一：
(B1) 复用 `snapshot_status` 现词表——batch 先写 `draft`，终笔 patch 翻 `active`；
(B2) 新增词表值（如 `staged`）——须走 optionSource 契约
`stock_preparation_snapshot_status_v1` 的治理扩词（option-sync 供给 + 迁移次序纪律）；
(B3) 不动 batch 行，新增独立 commit-marker 行（第 5 类对象）。

**硬约束冲突面（本锁不粉饰）**：
- **`frozenProjection` 含 `snapshotStatus` 且 plan 恒发 `draft`**（§1）——B1/B2 翻转后，同 plan 的
  每次 replay 变 409 `content_mismatch`，破坏幂等对（两 smoke 都断言）。B 必须**修改 #4382 刚硬化的
  判等器**（排除/归一 status 字段）——弱化刚建立的防线，需 owner 显式接受；
- **「create 后不 patch」契约**须开一个例外（终笔 status patch），模块头契约与 teardown
  「immutable audit substrate」doctrine 都要改写；
- **没有 reader 按 status 过滤**（§0.5）——B 要兑现「staged 不可见/可判」，须给**全部**消费端
  （view-2、diff current/base、confirm、generation、view-1 计数、dashboard）加过滤或折叠，
  否则 staged 值只是 view-2 里的一个原样回显字符串；FE 类型是 `| string` 会裸渲染；
- **终笔标记自身还是一次独立写**——崩溃在最后一行与标记之间留下「结构完整但未标记」态，retry 必须
  实现「结构复检后补标记」的**再入逻辑**（即 B 内生地包含一个小型方案 C）；
- TOCTOU 毒化与 CW4-existing stale 指针 **B 都不解决**（标记不改变 check-then-create 与
  project patch 的位置），仍需 §3 的锁/复检或接受残留。

**收益**：孤儿获得**机器可读标记**（结构推断之外的显式信号）；无 kernel API 变更（B3 亦然）。
但注意：读侧「incomplete」结构徽标（#4002）已交付了该收益的主要部分。

**覆盖**：CW1-CW3 从「结构可判」升级为「标记可判」（判定不变，语义更显式）；CW4-existing、
TOCTOU 不覆盖。**评估**：改动面 = 判等器 + 全部读端 + 契约文本 + 词表治理 + 两个 smoke，
大于其表面复杂度；且仍需再入补标逻辑。

## 5. 方案 C — repair protocol（显式修复协议）

**形态**：写序不动，孤儿不再是终态：新增 admin-gated、values-free、审计化的修复入口
（独立端点或 persist 的显式 `mode:'repair'`），语义 = **续写缺失后缀，绝不改写既有行**：

1. 复检既有前缀行与重算 plan 的冻结投影**逐字段一致**（复用 `assertExactReplay` 的比较器——
   它已实现有界分页全量读与投影判等）；不一致 → 维持 409 `content_mismatch`，修复拒绝；
2. 一致 → 只 create 缺失的 line（按确定性 `snapshotLineId` 差集）/ run / project 行；
   CW4-existing → 按既有 live-pointer 契约 patch project 指针（这是**已授权**的 patch 面）；
3. 修复本身幂等（确定性 id + 差集重算），可重入；每次修复动作落审计（8-action 面扩一类）。

**覆盖**：CW1-CW4 事后可愈（含 CW4-existing——修复是唯一能治**存量** stale 指针的方案）；
**不预防**：崩溃到修复之间孤儿仍暴露给 §0.4 的读侧（diff-base 幻造窗口仍在）；TOCTOU 双写**不可
修**（去重要删行，违反不可变契约——毒化仍是终态，只能 owner 手工）。无 kernel 变更、无词表变更、
读侧零改动。复杂度集中在 persist 模块一处。

## 6. 方案 D — 书面风险接受（现状 + 有界性实录）

**接受内容必须包含（本次核实后的完整清单，比既往认知多三条）**：
1. 孤儿 batch 可见且 retry 409（#4382 已保证）——**有界**；
2. **CW4-existing 静默 stale project pointer**——无任何观测面，**此前未记录**；
3. **孤儿可当 diff base/current**（服务端无门）→ 幻造 diff——**此前未记录**；
4. **TOCTOU 毒化不可逆**（同 batch key / 同 project 首写）→ 手工 SQL 才能解——**此前未记录**；
5. 最新批次为孤儿时 auto-pick 静默改选旧批次（行为正确但易误读）。

现有缓解：#4382 replay 409、incomplete 徽标 + FE diff 禁用、confirm/generation fail-closed、
dashboard 阻断提示。**评估**：D 在 1/5 上站得住；2-4 让「有界」声明比 #3995 时代弱——若 owner 选 D，
建议书面文本逐条列明 2-4 为已知未缓解暴露（或把 §9 的 H-1/H-2 作为 D 的最低配套）。

## 7. 对比矩阵

| 维度 | A 事务(+锁) | B 两阶段 | C repair | D 风险接受 |
|---|---|---|---|---|
| CW1-CW3 孤儿 | **预防**（零残留） | 标记可判（仍产生） | 事后可愈 | 保持（409 可见） |
| CW4-first | 预防 | 不覆盖（标记在其后） | 可愈 | 保持（409 可见） |
| CW4-existing stale 指针 | **预防** | 不覆盖 | **可愈（唯一治存量者）** | **静默保持** |
| 同 batch TOCTOU 毒化 | **预防**（in-tx 锁） | 不覆盖 | 不可修 | 保持（手工 SQL） |
| 同 project 首写毒化 | **预防** | 不覆盖 | 不可修 | 保持（手工 SQL） |
| 读侧 staged 可见窗口 | 无（单提交点） | 有，须全读端改造 | 有（修复前） | 有 |
| 不可变契约 | 不动 | **须开 patch 例外+改判等器** | 不动（补写后缀+已授权指针 patch） | 不动 |
| 词表/契约治理 | 不动 | B2 须扩词表；B1 弱化 #4382 判等 | 不动 | 不动 |
| kernel 改动 | **有**（3 文件+scope） | 无 | 无 | 无 |
| 长事务/锁成本 | 有（≤4 sheet fence + 行循环上界） | 无 | 无 | 无 |
| smoke 回归面 | 幂等对不变，预期零改 | **两 smoke 断言须改** | 新增修复断言 | 不动 |
| 相对实现成本 | 中（kernel+plugin） | 中-高（面广） | 中（单模块） | ~0（文档） |

## 8. 最低验证门（任一入选方案在实现 PR 必须交付）

1. **crash-injection 逐窗口**：在 records 边界注入第 k 次写后失败（scoped facade 注入缝；仓内先例：
   `packages/core-backend/tests/integration/multitable-d1c-*-realdb.test.ts` 等 failure-injection
   真库测试族），矩阵覆盖 CW1/CW2(k)/CW3/CW4-first/CW4-existing：
   - 方案 A：每窗口断言**零行残留**（回滚证明）+ retry 全新提交成功；
   - 方案 B：断言标记状态与结构状态的每种组合的读侧观测；
   - 方案 C：每窗口断言修复后结构完整 + 修复幂等（二次修复 no-op）+ 前缀不一致时修复拒绝；
2. **并发构造测**（[[TOCTOU 必须构造并发]]——顺序论证不接受）：barrier 同步双写者，
   同 batchId 与同 project 异 batch 两种竞态，断言终态唯一（A）或按方案语义收敛；
3. **mutation 载荷**（逐字验证 RED）：A 删 in-tx 锁 → 重复行出现；A 拆事务 → CW2 残留；
   C 删前缀判等 → 不一致仍修复；B 删读端过滤 → staged 泄漏；
4. **读侧回归**：view-2/diff/confirm/generation/view-1/dashboard 对孤儿/staged/修复后状态的
   行为逐一断言（含 auto-pick 改选行为）；
5. **values-free 扫描**：新增错误/审计/修复面全字段过 leak-scan；
6. **W6/T4 smoke**：幂等对与 teardown doctrine 断言在方案落地后逐字重验。

## 9. 与方案选择正交的微硬化（发现即记录，owner 可单独裁）

- **H-1 diff 服务端完整性门**：current/base 任一不完整 → 409（补上 FE-only 防线的服务端缺口，
  §0.4）；任何方案下都有独立价值；
- **H-2 replay 校验 project 指针**：`assertExactReplay` 对 CW4-existing 从 200 改为
  409 `{project, stale_pointer}`——把唯一静默窗口变可见（若选 A 则自动消失，选 C/D 则强烈建议）；
- **H-3 行数上界显式化**：persist 对 plan 行数设显式 422 上界（现仅由读界隐含 25,000）。

## 10. 推荐（倾向，非裁决）

**倾向：A（host 侧组合事务 + in-tx key 锁）为主，C 的一次性工具形态为辅**（清理存量孤儿/统计
毒化行，跑一次即退役；不建常驻修复面）。理由：
- 底座**已经**事务就绪（存储函数 tx 不可知 + 两个同形先例），A 的改动面（3 文件 + 采用）小于
  其名声；A 是唯一同时闭合全部五个窗口 + 两类毒化的方案；
- B 的真实改动面（判等器弱化 + 全读端 + 契约 + 词表 + smoke）大于 A，且仍内含再入补标逻辑、
  不闭合毒化——**历史上「两阶段修归 P4」的预期（#3995 时代）在本次事实核查后不再是最优路径**；
  两阶段的核心收益（显式可判）已被 #4002 结构徽标大部分交付；
- D 因 §6.2-4 三条新发现而弱于其在 #3995 时代的成立度；若 owner 仍选 D，建议至少配 H-1/H-2。

**留给 owner 的决策点**：
1. 选型 A / B / C / D（或 A+C 组合）；
2. 若 A：是否接受 kernel API 面新增（跨插件契约）+ 长事务上界裁量（§3 代价段）；
3. H-1/H-2/H-3 是否与选型解耦先行；
4. 存量孤儿/毒化行的处置口径（工具清理 vs 保留为审计残留）；
5. T3a ERP 兄弟模块（upsert-by-key 语义，无同型孤儿面但未审）是否纳入同一门。

## 11. 非目标

- 不改 RC-A 包与 #4437 流程；不动 `/mvp/sync/persist` 现有 replay 语义（#4382 已裁，本文仅引用）；
- 不推翻 batch-first 写序（:490-492 的设计意图保留）；
- 不引入外部写；不放宽 values-free；不在本锁内实现任何运行时代码；
- T3a `erp-material-sync-persist.cjs` 的原子性面留待 §10.5 owner 裁决后另行处理。
