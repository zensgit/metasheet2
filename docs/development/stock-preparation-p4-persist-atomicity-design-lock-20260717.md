# 备料 persist 原子性（P4）— 设计锁（PROPOSED — owner ratification required）— 2026-07-17

> **状态：PROPOSED。本文是四类方案的比较与验证设计，不是裁决。**
> 依 T3b 锁 OD-4（`stock-preparation-t3b-plm-source-autopersist-design-lock-20260716.md:248-249`）：
> autopersist 生产常开保持 barred，直到独立 P4 完成**事务 / 两阶段状态 / repair protocol**
> 之一并有 crash-injection 证据，或 **owner 另行书面接受该有界风险**。本文逐一展开这四类方案，
> 给出对比矩阵与最低验证门；**推荐仅为倾向，最终选型留 owner ratify。**
> 本文不改任何运行时代码，不影响 RC-A（#4437）的 exact 包 SHA（`d87e086fd1…`）。
> 全部代码事实以 origin/main `9048c27e2` 为锚（file:line 均指该 ref）。
>
> **owner review round-1（2026-07-17，REQUEST_CHANGES，暂不 ratify）——本版已吸收**：
> ①方案 A 必须是**受限 unit-of-work**（key lock、锁内存在性复检、replay 判定、混合 create/patch、
> revision 发射全在同一事务内）——泛化 bulk-create API **不构成事务闭包**（§3 已重写）；
> ②**H-1/H-2 是现存静默正确性缺口，先行必修，不随选型等待；H-3 是方案 A 的前置**（§9 已重分类）；
> ③方向条件接受 **A + 一次性 C 工具**、落地姿态=**硬切换**、**T3a 原子性另审**（§10 已按此更新）。
> 正式 ratify 待 owner 复核本版。

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
`{sheetId, data}`，**无任何事务/client 传递参数**（`packages/core-backend/src/types/plugin.ts:436-499`，
`MultitableRecordsAPI` 共 6 个单记录方法，无 bulk/batch/unit-of-work）。崩溃只会落在整行提交之间，
部分状态永远是「整数个完整行」。

存储面：`meta_records` 每记录一行，全逻辑字段在 `data` jsonb 里，PK 只有 `id`
（`rec_${randomUUID()}`），**逻辑键上没有任何唯一约束**（DDL
`zzz20251231_create_meta_schema.ts:44-51`；索引全部非唯一，含 GIN(data)，
`zzzz20260413110000_add_meta_records_query_indexes.ts:12-15`）。`snapshotBatchId` 唯一性**只靠**
persist 模块的 limit-2 预检 + 409。（plugin 面 API 完整清单：`types/plugin.ts:436-499`。）

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
  竞态**不产生重复行但也不被 fence 序列化**：patch 路径的 `fenceWriterEntry`（`records.ts:498`）
  是 flag-gated no-op（`MULTITABLE_ENABLE_WRITER_FENCE` 默认 OFF，
  `canonical-sheet-fence.ts:134-138,185`；`records.ts:495-497` 注释明言 OFF 时 byte-identical）——
  默认部署下读（:503，普通 SELECT 无 FOR UPDATE）与 UPDATE（:519-525）之间是**未序列化的
  read-modify-write，行级 UPDATE 锁上 last-writer-wins**。对本模块只写 3 个 pointer key 的闭集
  patch 是良性的（无重复行、无毒化），但对 project 行其他字段存在 lost-update 面——这也进一步
  支持方案 A 把 project patch 收进事务。
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
`draft` 且永不翻转**（:296 注释「status 'draft', never 'active'」+ :303 赋值）——完整提交与崩溃
孤儿在状态上**不可区分**，完整性只能结构性证明（run 行 + 完整 line 集 + project 行），这正是
`assertExactReplay` 的算法。run status ∈ {running, succeeded, failed, partial}；prep-line 实际词表只有
{draft, held}。**没有任何 reader 按 `snapshotStatus` 过滤**（存储值的唯一读取点是
`snapshot-reads.cjs:199` 的原样回显；persist/plan 侧另有对 plan 值的 evidence 回显，FE 对回显值
裸渲染）。

### 0.6 错误面与调用方

- 中途底座失败 → 无 `.status` 的异常 → HTTP 500，公开 code = 原始 `error.code || error.name`
  （pg 错误会以 SQLSTATE 形态出现；字面 `INTERNAL_ERROR` 实际几乎不可达；name-regex 分支可产生
  400/404/409/422，`http-routes.cjs:402,432-453`）。**不泄露 partial counters / identity**
  （`linesCreated` 是局部变量，仅进成功返回 :515）。
- 生产调用方恰两个，共享同一模块：`POST /mvp/sync/persist`（:3887-3915）与 T3b flag-gated
  source-run 桥（:3982，默认 OFF）。T3a ERP 走**兄弟模块**
  `stock-preparation-erp-material-sync-persist.cjs`（upsert-by-key 缓存语义，不在本锁范围，
  见 §10 决策点 5）。apps/ 无前端调用方。

## 1. 继承的权威约束（不重开已裁决项）

- **快照不可变**：batch/line/run 创建后不 patch；project 是 live pointer，仅按既有 contract upsert
  （T3b OD-4；persist 模块头 :26-31）。
- **replay 语义已硬化（#4382，已合并，不属本锁改动面）**：孤儿 retry = 409（非 false skip）；
  同 id 异内容 = 409 `content_mismatch`；判等 = 冻结模板全投影（`frozenProjection` :186-204，
  **含 `snapshotStatus`**——对方案 B 是硬约束，见 §4）。
- **values-free**：新增状态、错误、修复动作的公开面不得含 partial counters / identity / 业务值。
- **外部写零授权**：本锁与外部写无关，`externalWrite=false` 姿态不变。
- **W6/T4 smoke 现有断言**（`stock-preparation-mvp-postdeploy-smoke.mjs:630-700`、
  `prep-line-extended-smoke.mjs:45,281-309,485-496`）：201 created→200 skipped_existing 幂等对、
  batchCount===1、incomplete===false、teardown 视 batch/lines/prep-lines/exceptions 为
  **immutable audit substrate**（:45 头注）。任何方案落地时这些断言是回归面。

## 2. 方案定义域

OD-4 允许的四类。每类先给最小诚实形态，再给覆盖/残留。

## 3. 方案 A — 事务（host 侧**受限 unit-of-work**，非泛化 bulk-create）

**形态（round-1 收紧后的定义）**：`records.ts` 的存储函数**已经是事务不可知的**（接受注入的
query fn，:598-601；host 在构建 CoreAPI 时选边界）。但**泛化的
`createRecordsAtomic([{sheetId,data},…]) 批量创建 API 不构成事务闭包**——真实 persist 流程还包括
锁后重新查询、replay 判等、project create-vs-patch 分支，这些若留在事务外，check-then-create 的
TOCTOU 原样存在。故 A = host 侧新增**一个受限 unit-of-work 组合原语**（备料 persist 专用 composite，
或 records 侧通用 unit-of-work——形状由实现 PR 定），单个 plugin 调用，在**同一个**
`poolManager.get().transaction` 内按序完成全部五步：

1. 按 `acquireCanonicalSheetFencesInOrder` 的既有次序取 4 张 sheet 的 fence，再取 key 级
   `pg_advisory_xact_lock`（`hash(sheetId|snapshotBatchId)`、`hash(sheetId|projectId)`）；
2. **锁内复检**：batch 存在性（limit 2）、project 存在性/唯一性、命中已有 batch 时的**完整
   replay 判等**——即 create / skip / 409 的**判定本身发生在锁内**，不是锁外判定锁内执行；
3. 判定为 create → batch/lines/run 逐行 create + project 的 **create-or-patch 分支**同事务执行；
4. 逐行 revision 发射同事务（键在共享 tx query 上，自动保持正确）；
5. 单 COMMIT；任何一步失败 = 整体回滚，零残留。

改动面：`types/plugin.ts`、`index.ts`、`plugin-scope.ts`（逐 sheetId scope 断言）+ persist 模块
把「预检-判定-写入」整段迁入原语。**H-3（显式行数上限）是本方案的前置**：引入长事务前必须先落地
显式 422 上界，不能只靠 25,000 行的 replay 读界隐含约束（§9）。

**先例**（同架构形状已在仓内）：
- `provisioning.ensureObjectInScope`：单个 plugin 调用背后的 host 侧一事务多写组合
  （`index.ts:1448-1480`）；
- kernel `RecordWriteService.patchRecords`：一次 bulk 多记录 patch = 一个 mutation 事务
  （`record-write-service.ts:677-685,985-1000`）——底座支持多记录原子写，只是未经 plugin SDK 暴露。

**并发闭合即步骤 1-2 的锁内复检**（单靠事务**不**闭合 §0.3 的重复窗口——`meta_records` 无逻辑键
唯一索引）：key 级 xact 锁随 COMMIT 释放，「复检-判定-写入」整段在锁内 ⇒ 同 batch 双写与 project
首写竞态收敛为「一胜一 skip/409」。锁次序统一为「sheet fence（sheet-id 排序）→ key 锁（同样确定性
排序）」，全仓一个约定。（替代方案：`(sheet_id, data->>'snapshotBatchId')` 部分唯一表达式索引——
影响面跨所有含该字段名的 sheet，治理成本更高，仅作备选记录。）

**代价（真实成本，须写进验收）**：
- 组合事务持有至多 4 张 sheet 的 advisory xact lock 直至 COMMIT（`auto-number-service.ts:23-31`
  per-create fence）——**锁获取次序必须固定**；kernel 已有现成纪律与 helper：
  `acquireCanonicalSheetFencesInOrder`（`canonical-sheet-fence.ts:91`，去重 + **sheet-id 排序**，
  注释明言为未来多 sheet 写者预留）——组合原语应复用该次序，不另立约定；
- 行数上界：replay 读路径的可证界为 500×50 = 25,000 行（`persist.cjs:72-73`，超界
  409 `PERSIST_EXISTING_BATCH_READ_UNPROVABLE`）；**create 循环自身无强制上界**（与 §9 H-3 一致，
  「现仅由读界隐含」）→ 单长事务风险按该隐含界评估；须裁量显式上限或分段策略（分段则回到部分
  可见，须显式取舍——建议 v1 直接沿用现有 plan 规模上限并压测）；
- flag-gated `assertNoActiveWriterBlock` 每 create 跑一次（:612-614），事务内语义不变但持锁时长增加；
- kernel API 面新增 = 跨插件契约，需 W0 canonical fence 相容性审（组合内逐行 revision 发射同事务，
  初判相容，须在验证里证明）。

**落地/迁移姿态（round-1 已裁：硬切换）**：persist 模块被两个生产调用方**共享**
（`/mvp/sync/persist` 路由 :3895 + T3b 桥 :3982）——采用组合原语是**两口同时切**。T3b OD-4 先例
（t3b lock :244-246）把共享 persist 变更定为**非 inert**：须独立 PR + 对现有路由兼容回归 + 真库
证据 + owner review。owner round-1 裁定采 **(ii) 硬切换 + OD-4 式独立 PR 纪律**（不留 default-OFF
双路径——双路径违背「一个写面」原则）。

**覆盖**：CW1-CW4 全闭（单提交点，中途失败=全回滚，零残留）；CW4-existing 的 project patch 进事务
→ stale 指针窗口闭合；TOCTOU 毒化闭合（in-tx 锁）。**残留**：存量孤儿/毒化行不自愈（一次性清理归
方案 C 的工具形态或 owner 手工，见 §5）；`assertExactReplay` 全套保留为纵深防御。

## 4. 方案 B — 两阶段状态（staged → committed 标记）

**形态**：沿用现写序，把「提交完成」显式化为一个终笔标记。表示法三选一：
(B1) 复用 `snapshot_status` 现词表——batch 先写 `draft`，终笔 patch 翻 `active`；
(B2) 新增词表值（如 `staged`）——须走 optionSource 契约
`stock_preparation_snapshot_status_v1` 的治理扩词（option-sync 供给 + 迁移次序纪律）；
(B3) 不动 batch 行，新增独立 commit-marker 行（第 5 类对象）。

**标记位置钉死**：终笔标记必须落在 **project upsert 之后**（成为整个 commit 的最后一笔）——
放在 run 与 project 之间会「先宣告完整、后写 project 行」，严格更差。由此 CW1-CW3 **与 CW4-first**
在 B 下同样是「未标记=staged 可判」；CW4-existing 例外：B 的再入补标逻辑按结构复检通过后补标，
会把 stale 指针**重新静默化**（复检只查存在性时），除非补标前显式校验指针内容。

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
建议书面文本逐条列明 2-4 为已知未缓解暴露。（round-1 后 H-1/H-2 已定为无条件先行必修（§9），故 D 的实际接受面缩小为：TOCTOU 毒化残留 + auto-pick 改选语义 + 不做 A/B/C 本体。）

## 7. 对比矩阵

| 维度 | A 事务(+锁) | B 两阶段 | C repair | D 风险接受 |
|---|---|---|---|---|
| CW1-CW3 孤儿 | **预防**（零残留） | 标记可判（仍产生） | 事后可愈 | 保持（409 可见） |
| CW4-first | 预防 | 标记可判（仍产生） | 可愈 | 保持（409 可见） |
| CW4-existing stale 指针 | **预防** | 不覆盖（再入补标反而再静默化，§4） | **可愈（唯一治存量者）** | **静默保持** |
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

## 9. 硬化项分级（round-1 重分类：不再是「可选微硬化」）

- **H-1 diff 服务端完整性门 = 先行必修**（不随选型等待）：现状允许不完整 batch 进入 diff
  current/base（§0.4），是**现存静默正确性缺口**——current/base 任一不完整 → 409。独立小 PR 先行。
- **H-2 replay 校验 project 指针 = 先行必修**（不随选型等待）：现状让 CW4-existing 的 stale
  project pointer 返回 200 skipped_existing，同为**现存静默正确性缺口**——`assertExactReplay`
  加指针内容校验，stale → 409 `{project, stale_pointer}`。独立小 PR 先行（选 A 后该窗口在新写面
  自动消失，但存量行为与 A 落地前的窗口仍需此门）。
- **H-3 行数上界显式化 = 方案 A 的前置**：persist 对 plan 行数设显式 422 上界（现仅由 replay
  读界隐含 25,000）——**必须在引入长事务之前落地**，作为 A 实现 PR 的 gate 序里的第一件。

## 10. 推荐（倾向，非裁决）

**倾向：A（host 侧组合事务 + in-tx key 锁）为主，C 的一次性工具形态为辅**（清理存量孤儿/统计
毒化行，跑一次即退役；不建常驻修复面）。理由：
- 底座**已经**事务就绪（存储函数 tx 不可知 + 两个同形先例），A 的改动面（3 文件 + 采用）小于
  其名声；A 是唯一同时闭合全部五个窗口 + 两类毒化的方案；
- B 的真实改动面（判等器弱化 + 全读端 + 契约 + 词表 + smoke）大于 A，且仍内含再入补标逻辑、
  不闭合毒化——**历史上「两阶段修归 P4」的预期（#3995 时代）在本次事实核查后不再是最优路径**；
  两阶段的核心收益（显式可判）已被 #4002 结构徽标大部分交付；
- D 因 §6.2-4 三条新发现而弱于其在 #3995 时代的成立度；（H-1/H-2 现为无条件先行必修，不再作为 D 的配套选项，§9。）

**决策点状态（round-1 后）**：
1. 选型：owner round-1 **方向条件接受 A + 一次性 C 工具**——正式 ratify 待本版复核；
2. ~~落地姿态~~ **已裁：硬切换 + OD-4 式独立 PR 纪律**（§3 落地段）；
3. ~~H-1/H-2/H-3 是否解耦先行~~ **已裁：H-1/H-2 先行必修，H-3 为 A 前置**（§9）；
4. **仍开放**：存量孤儿/毒化行的处置口径（工具清理 vs 保留为审计残留）；
5. ~~T3a 是否纳入~~ **已裁：T3a 原子性另审**，不入本门。

## 11. 非目标

- 不改 RC-A 包与 #4437 流程；不动 `/mvp/sync/persist` 现有 replay 语义（#4382 已裁，本文仅引用）；
- 不推翻 batch-first 写序（:490-492 的设计意图保留）；
- 不引入外部写；不放宽 values-free；不在本锁内实现任何运行时代码；
- T3a `stock-preparation-erp-material-sync-persist.cjs` 的原子性面留待 §10 决策点 5 owner 裁决后
  另行处理。
