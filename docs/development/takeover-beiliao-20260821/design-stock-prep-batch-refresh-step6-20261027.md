# Step 6 — FINAL binding design: recovery verify-and-close (6a), execution and batch read surfaces (6c), doubled-sheet census, remnant readiness and repair tooling (6d). The batch identifier (首次批次 / 本次拉取) is owned by the batch-identifier line (BI); step 6 consumes it through a stated interface.

## 2026-11-09 改正（rebaseline）

**读法。** 本节之后的正文是 2026-10-27 定稿的原文，只做了三类机械改动：登记行号（见 R-1）、BI 的登记行号（见 R-2）、私有路径与工作流句柄换成占位符（见 R-3）。正文写成时，批次标识（BI，登记 R-65）还在设计阶段；BI 系列现已全部合入 main，PR-8（#6584）、PR-9（#6791）与 S6-0（#6600）也已合入。**凡本节与正文不一致，以本节为准。** 本节逐条列出 2026-11-09 设计重基线（协调者私有记录，非仓库文件）的全部改正；正文里的 `CS` / `TA` / `HR` / `AW` / `LK` / `RDY` 行号按 10-27 基线写，实施时以本节和合并后的代码为准。

**基线。** 正文的 `M:` = 5b9ec081b、`P8:` = c43238477、`BI:` = BI 设计 v1；本节的基线是 `origin/main` **7643f3811**（2026-11-09 fetch）。下列事实已在 7643f3811 上亲读核对：`stock-preparation-continuation-support.cjs:21` 仍是 `CONTINUATION_SUPPORT_VERSION: 0`；`stock-preparation-pull-batch-store.cjs:809-810` 对 `sourceDigest` 只接受 32 位小写十六进制（`PULL_BATCH_SOURCE_DIGEST_PATTERN`，否则在 try 之前抛 `inputInvalid`）；`stock-preparation-pull-batch.cjs:690-699` 的摘要方案是 `stock-preparation/pull-batch-source/v1`，不带车道前缀；`stock-preparation-project-write-lock.cjs:160-161` 两个词表的末项是 `pull_batch_install`；`stock-preparation-pilot-readiness.cjs:93` 为 `PILOT_READINESS_VERSION = 3`；迁移目录到 105 为止，106–108 不存在；`S8-04c` 在 `packages/core-backend/tests/integration/stock-preparation-project-write-lock-realdb.cases.ts:7196`。其余行号取自重基线，本 PR 未逐条复核，实施的 PR 在动手前重读。下文 lib 路径都相对于 `plugins/plugin-integration-core/lib/`，迁移相对于 `packages/core-backend/migrations/`。

### R. 编号与文字

- **R-1 登记行。** 第 6 步的 T 层决策登记为 **R-91**（R-65 已由 BI 占用，R-90 归集成线）。正文 §1 标题、§9.6、§10 S6-8、§13 S6-8 标题、§14.2 O6-10 原写 R-65 处已改为 R-91。
- **R-2 BI 的登记行。** 正文原把 BI 写作 R-64（10-27 的预留号）；main 上 R-64 是宜搭「测试连接」，BI 是 R-65。§1 T6-10、§4.1、§4.2 C-11、§9.1、§9.6 已改为 R-65。
- **R-3 占位符。** 输入清单与基线里的私有草稿路径、协调日志路径和两个工作流句柄换成了 `<private scratch: …>`、`<private coordinator log, …>`、`<BI workflow>`、`<PR-8 round-2 workflow>`。正文里没有主机、IP、凭据，也没有真实项目、图号或客户名称。正文引用的分批刷新方案 `batch-refresh-merge-plan-20261022.md` 尚未入库，只在协调者的工作副本里，引用按原文件名保留。

### A. BI 合并后的接口状态（取代 §4.2「BI v1 status」一列与 §14.1 OQ-1…OQ-3）

- **A-1 OQ-1 已结。** BI 最终代码（#6808 账本与 105、#6814 盖章与就绪 v3、#6815、#6817、#6818、#6830、#6831）已满足 C-1、C-2、C-4、C-5、C-6、C-7、C-10、C-11，以及 F-BI-1…F-BI-5 全部。§4.2 的「BI v1 status」一列只是历史记录。第 6 步还要改的只有 C-3（摘要入参）和 C-8（S9X-01 加 RS-2/RS-3 计数），另加两条新约束 N-SWITCH、N-INSTALLING（见 B-6、B-9）。
- **A-2 OQ-2 已结。** `assertHolderWithin` 已由 BI 引入。S6-2 原样复用，`reason: 'recovery_close'`，合同与 §3.6 第 2 步一致：`holderWithin = lock.assertHolderWithin(trx, guard.scopeKey, { leaseId: guard.hostWriteFence().leaseId, fencingEpoch: guard.fencingEpoch, reason: 'recovery_close' })`，按 `HR:6314` 的先例写。
- **A-3 OQ-3 已结。** `readBatchLink` / `batchWithin` / `listBatches` 都在 BI 的 store 模块里。§14.1 OQ-3 的「原样保留」退路作废。恢复只在车道开关打开、且有 store 时才调用这些函数（见 B-6）。
- **A-4 C-6 与锁序。** S6-2 对 `closeExecution` 用同样方式包裹。锁序仍然无环：BI 事务先锁 lock 行，从不锁 refresh-state 行；关闭的次序是 state → lock → execution → continuations → plans → BI link → BI batch，从不锁 `_sheet` 行；决策事务先锁 state 行，再走 `bumpWithin`（`CS:1538-1541`、`:1715`）。
- **A-5 C-7 / C-12。** 第 6 步不需要再改。「最近一次拉取」口径（O-BI-2）与「批次列进正式导出」（O-BI-6）都是 owner 延后项；任一重开，两个摘要生产方必须在同一 PR 里一起改。
- **A-6 OQ-11。** 普查包的 CI 证据仍是 p4 宿主里的 S9D-02；把包列进 `ops-sql-pack-verify.yml` 仍是可选项，需要带 workflow 权限的推送。

### B. 设计改正

- **B-1 C-3：sourceDigest 改用 BI 的摘要（必须改）。** 原设计给 `batchWithin` 传 `'small:' + execution.source_content_digest`，用的是 RL 方案的摘要（`TA:1865-1872`）。`store:809-810` 只认 32 位十六进制，结果是：开关打开的表上，每一次恢复关闭都会以 500 `STAMP_INVALID` 回滚。改为：
  - 106 **去掉** `source_content_digest`，**加** 可空列 `pull_batch_source_digest`，存 BI 的摘要（`stock-preparation-pull-batch.cjs:690-716`：方案 `pull-batch-source/v1`，32 位十六进制，无车道前缀）；
  - 只在本次运行确实盖章时写入：在 `prepareSmallApplyPullBatch` 的运行对象上暴露 `sourceDigest`（lanes:385），或用 `pullBatchCanonicalRows`（`TA:1687`）重算；
  - 删去 CHECK 子句 `intent_version IS NULL OR source_content_digest IS NOT NULL`，改加一个 32 位十六进制的形状 CHECK；begin 只在缺 intent 时拒绝；
  - S6-2 把执行行上**不带前缀**的 `pull_batch_source_digest` 原样传给 `batchWithin`；有关联时断言它等于 `readBatchLink().sourceDigest`；
  - 结果是裸字符串 `none` / `kept_open` / `closed` / `already_closed`。`already_closed` 只出现在一种情况：批次已被本关联自己的成功写入方以 `execution_succeeded` 关闭（store:838），即 E05 路径，因为 BI 的 finish 先于第 4 步的 finish 运行（`TA:3439` 对 `:3447`）。
  - 正文 §3.2、§3.6 第 6 步、§4.2 C-3、§7.2 的 106 草图里 `source_content_digest` 的写法，按本条改读。
- **B-2 写入器的 IO 前拒绝不止三处（S6-1）。** BI 的盖章准入也在任何 IO 之前拒绝：`pullBatchRunOf`（`AW:1041`）→ `AW:1239-1255`，500 `STAMP_INVALID`、`partial: false`，位置在 `write_fence_required`（`AW:1058-1060`）之前。把它标成 `pre_io`（不标也是安全一侧）。`WRITER_PRE_IO_REASONS` 在 XS-04 里按新列表钉住；正文 §2.3 F6-16、§3.3 里的「三处」按本条改读。
- **B-3 分配停止（S6-1）。** 分配停止（`AW:621-633`）是循环内停止：分配在围栏之前运行（`AW:667-672`），所以在第一笔创建处停止是 0/0，自校验结论正确。C-5 成立，因为 BI 自己的 finish 先跑。
- **B-4 intent 字段带（S6-1）。** intent 的比较字段带取自 `derivePackAwarePlmWritableFields`（`AW:1033-1036`）。Y8 #6778 合入后它会排除 `MACHINE_WRITEBACK_FIELD_IDS`；XI-02 要把这个 id 和两个批次列 id 都列入「永不出现在 fieldset」的断言。
- **B-5 关闭事务放进 `guard.withHostWrite`（S6-2，N6 心跳规则）。** 关闭若在 `guard.withHostWrite` 之外持有 lock 行 FOR UPDATE，恢复自己的心跳会排在它后面；超过 30 s 池超时就会把守卫判为丢失（N6 一类，`LK:1134-1155`）。改为在 `guard.withHostWrite` 内执行关闭。正文 §3.9 第 15 行与 S9R-29d 按此改写。
- **B-6 N-SWITCH：开关关闭时，第 6 步的每个批次字段都不出现（R61 / 裁定 C6、C12）。** `STOCK_PREP_PULL_BATCH_ENABLED` 不是精确 `'true'` 时：
  - §3.5.2 报告的 `batch` 字段、§5.1 列表项的 `batch` 字段**不出现（是缺席，不是 null）**；
  - §5.2 的批次路由答 404，零 IO（设置路由先例 `HR:6454-6461`）；§5.3 的「批次」区块隐藏；S6-3 的批次行只在开关打开时渲染；
  - 关闭跳过 BI 一步（只在 `pullBatchContextFor` 给出的车道已启用且有 store 时才调用 `readBatchLink` / `batchWithin`；开关关闭 = 账本零 IO）；`verifyDigest` 里 `verifiedCreatedRows` 记 0；
  - `execution_recovery_ready` 的 BI 子句改为「开关打开 ⇒ `readBatchLink` 与 `batchWithin` 已接线」（正文 §8 写的是「band present ⇒」）。
- **B-7 僵尸写入方的 BI finish（S6-2）。** 接管之后，僵尸的 BI finish 是 `holder_refused` 空操作（store:730、:753）。正文 §3.9 第 3、11 行和 S9R-25 按此改写。**S9R-BI-04 删去**（BI 的 BI-R14 已覆盖）；S9R-BI-01…03 保留，因为 `batchWithin` 目前只有密闭覆盖（ST-S2/S3，`__tests__/stock-preparation-pull-batch-store.test.cjs:326-363`）。
- **B-8 就绪版本重排（取代正文 §1 T6-14、§8）。** BI 已占 v3，且 v3 已含 locked 与 visible 两项检查。新顺序：
  - **S6-2 → v4**：`change_plan_store_readable`、`execution_recovery_ready`；
  - **S6-5 → v5**：只剩 `no_unacknowledged_inactive_root_remnant` 一项；正文 §6.5 / §8 里的 `pull_batch_columns_visible`、`pull_batch_columns_locked` **删去**；
  - S6-7 → v6（仅在做 S6-7 时）。
  - 新检查插在 `continuation_support_version` 之前（BI 先例，`RDY:131-133`）。正向一腿（S6-9）包括开关打开时 BI 的六项检查。乱序合入的 PR 在合并时取下一个版本号。
- **B-9 N-INSTALLING：表处于 installing 时。** BI 的装机不读刷新治理（在 `stock-preparation-pull-batch-install.cjs` 里 grep `governance|consult|recovery|unfinished|pilot` 无命中），所以装机可以在「失败待恢复」的项目上运行；这对不看批次带的恢复是安全的，但必须钉住：
  - S6-2 **允许**在 installing 时核对 / 关闭，并钉两个用例：关闭不动 `_sheet` 的 version 与 `settings_locked_at`；在失败运行与其恢复之间跑一次装机，不改变不看批次带的分类结论；
  - S6-6 在 BI 表行处于 installing 时**拒绝**（105:114-115）。
- **B-10 修复窗口不得与装机窗口交错。** 装机的历史方案按各行当前的「有效」状态构建（裁定 C10，规则 F），两次装机运行之间做一次 retire 会改变该方案的输入；装机在租约内的摘要核对随后会拒绝（fail-closed，但会白白耗掉一个 owner 窗口）。运行手册（S6-8）规定修复窗口与装机窗口的先后，二者从不交错。retire / restore 从不碰批次列单元格，裁定 C7 不受影响（store:1090-1141）。
- **B-11 S8-04c 与 CP-S09 重新钉住（S6-1）。** PR-8 已合并的 S8-04c（`stock-preparation-project-write-lock-realdb.cases.ts:7196-7236`）钉的是 `aborted`、`invalidated(execution_failed)`、`failed_pending_recovery`。S6-1 之后改为 `verified_closed / self_verified`，CP 保持 `confirmed`，项目派生为 `confirmed_pending_execution`。同时核对 CP-S09（`__tests__/stock-preparation-change-plan-store.test.cjs:745-772`）。**这是对一个已合并、owner 批准过的 PR-8 行为的改变：零尝试的绑定停止不再使计划失效，而是让计划保持已确认。** 该改变写入 R-91。
- **B-12 BI 源码扫描计数 RS-1 / RS-2 / RS-3（C-8）。**
  - RS-2 钉住 `TA` 里恰好 4 处 `computeDryRun(` 调用（`__tests__/stock-preparation-pull-batch-reader-scan.test.cjs:154-166`），恢复入口使之变为 **5**；
  - RS-3 钉住 4 个小车道路由入口（`:168-189`），恢复入口须传 `pullBatchLane` 与 `pullBatch:` 并加入该列表；
  - RS-1 钉住（文件, 种类）多重集（`:125-152`；今天 http-routes 是 5 个 `call:band`、4 个 `ref:deps`）；S6-5、S6-6 新增的读取调用点都须传 `pullBatchBand` 并同步改 RS-1。
  - S9X-01 在 S6-9 的 G9 里跑，或更早作为真库用例。
- **B-13 迁移号。** 106（S6-1）、107（S6-5）、108（S6-6）在 main、全部 ref、R 线标签和最新 200 个在开 PR 上都还空着，本设计保留它们，发布时再查一次。注意：更早的 367 个在开 PR 未扫描（最早扫到的 #6373 创建于 2026-10-13，早于 2026-10-23 加入迁移 100 的 #6501）。正文 §7.4 第 2 条改写为：R83 现场上，凡在 4a1f1158e 之后切出的 main 包都带 105。
- **B-14 OQ-13 锚点迁移（S6-1 内完成）。** `TA:3245-3271` → `TA:3376-3400`；`HR:4773-4826` → `HR:4936-4996`；`HR:8466-8476` → `HR:8948-8972`；`HR P8:4831-4862`（审计钩子泛化）→ `HR:5001-5029`。
- **B-15 S6-1 的其余要求。** S9R 用例放在一个新的 cases 模块里，从 p4 宿主注册（#6600 / #6808 先例），不放进 #6778 也在改的 write-lock cases 文件。
- **B-16 S6-2 的其余要求。**
  - CS 新增 `readExecutionForRecovery`、`closeExecution`、`listExecutions`；CS 的 `requireTrx`（`CS:1171-1177`）同时要求事务句柄提供 `setLocalLockTimeout`（`db.cjs:518-531` 的句柄有）；
  - TA 新增 `recoverStockPreparationExecution` 与分类器；HR 三条路由，WA 各加一行；
  - 锁词表在 `pull_batch_install` 之后追加 `recovery_verify` / `recovery_closed`（`LK:160-161`）；
  - 决策上下文为 close-unverified 加一个档位选项（admin）；
  - 审计 detail 只能放深度 1 的令牌和数值计数表（`audit-store.cjs:138-161`）；
  - 无迁移。
- **B-17 S6-4。** 批次路由基于 `listBatches`，审计为 `project_board_read`、mode `pull_batch_list_read`；开关关闭时 404、零 IO（B-6）；复用 BI-3 的文案；rail 移位；执行区块等 S6-2。可选拆分：批次路由与 rail 移位可以先于 S6-2。O6-1 仍须先记录，owner 仍可延后（O6-2）。
- **B-18 S6-6。** 复用 `pullBatchFencedPatchFor` 的模式，不另写 `runFencedPatches`（取代正文 §6.6 的写法）；两个 LK 词表都追加 `sheet_repair`；新开关登记进 flag manifest（#6764 / #6782 / #6789 / #6793 也在改该文件）；installing 时拒绝（B-9）。
- **B-19 S6-3。** 卡片、每个新码的 plainLanguage 条目、定时拉取 F-14 结论指向卡片、browser-verify 夹具、spec 令牌登记（保留 main 的行再追加）。跨线：#6793 / #6795 把 `STOCK_PREP_REFRESH_RECOVERY_PENDING` 记作失败步骤结果，并从 `scripts/ops/stock-preparation-scheduled-pull.mjs` 导入 `pullOneProject` / `summarize`，该脚本的导出须保持稳定。
- **B-20 S6-8。** 现在起草，S6-6 之后定稿。补：恢复与装机的交错（B-9）、修复窗口不与装机窗口交错（B-10）、为 R83 现场改写的 §7.4 第 2 条（B-13）、U07 停止条件 SQL。#6778 也在改 switch-on 运行手册，需协调。
- **B-21 S6-9。** 只在 S6-1、S6-2、S6-3、S6-5、S6-6、S6-8（以及 S6-4，除非延后）各自在冻结头上评审并合入、就绪 ≥ v5 之后翻转。正向一腿需要内存中打开 BI 开关，并有一张已装 BI、历史已解析的合成表；G9 覆盖 S9X-01、U07 演练，以及包括 BI 管理路由在内的 U03。只随 main 基线包发布，永不进 R 线。

### N-INTEGRATION：与集成线的配对（不等待）

集成线在开的 Draft（#6764、#6769、#6782、#6789、#6793、#6795、Y8 #6778）都会碰到第 6 步的文件。不等它们（R-69 仍 OPEN，Y8 由 owner 把关）；后合并的一方负责 rebase 并重算 s6a pins。配对：S6-1 ↔ #6778（AW 字段带；XI-02 加机器回写列）；S6-2 / S6-4 / S6-5 / S6-6 ↔ #6769 一叠（http-routes；在 G-06 之下，新处理函数只读那六个请求字段）；S6-6 ↔ flag manifest；S6-3 / S6-4 ↔ web 令牌文件；S6-7 ↔ #6778 的 pairing；S6-8 ↔ #6778 的运行手册。自动化试运行是 §3.9 第 14 行多出的一个并发对账调用方（同一代码路径）。

### 改正后的 PR 次序（取代正文 §13 的「Order」一段与 S6-8 的标题）

| # | PR | 难度 / 规模 | 依赖与说明 |
|---|---|---|---|
| 0 | S6-0 普查模块 + R 线 psql 包 | — | **已完成**（#6600，99f4ab357）。现场运行是 owner 授权的客户数据读取（O6-3），可并入 BI-6a 探查窗口（O-BI-9）。 |
| 1 | 本 PR：设计入库 + 登记 R-91 | S，docs | 先发布，让 24 h 否决窗口在 S6-1 合入前走完。 |
| 2 | S6-1 intent 日志、自校验收尾、结算主体（迁移 106） | D4，M-L，约 2.5k 行含测试 | PR-8、BI-1 都已合入，现在可以开工。含 B-1…B-4、B-11、B-14、B-15。 |
| 3 | S6-5 普查路由、残留确认、就绪 v5（迁移 107） | D3，M，约 1.5k | 与 S6-1 / S6-2 并行开发；在 S6-2 之后合入，否则合并时取下一个就绪版本。 |
| 4 | S6-6 双份表修复工具（迁移 108） | D4，L，约 3k | 并行开发；在 S6-2 之后合入（LK 词表次序）。真实运行按表走 gate 2。 |
| 5 | S6-2 恢复核对与关闭、close-unverified、执行列表、就绪 v4 | D4，L，约 4k | 在 S6-1 之后。无迁移。含 B-1、B-5…B-9、B-12、B-16。 |
| 6 | S6-3 「拉取待确认」里的恢复卡片 | D2，M，约 1k | 在 S6-2 之后。 |
| 7 | S6-4 「BOM 快照批次与差异」PULL 模式 | D2-D3，M，约 1.2k | 在 S6-2 与 O6-1 之后（批次路由与 rail 移位可提前）；owner 可延后（O6-2）。 |
| 8 | S6-8 第 6 步运行手册附录 B.4–B.7、交付指南 | D1-D2，M | 现在起草，S6-6 之后定稿。登记行已由本 PR 建立，S6-8 只做登记册收尾。 |
| 9 | S6-9 `CONTINUATION_SUPPORT_VERSION` 1 | S 代码 + D4 验证（标签上的 G9） | 在 2、3、4、5、6、8 之后（以及 7，除非延后）。 |
| 10 | S6-7（有条件）限定范围的 dropped-head 裁定 | D4，L | 只在客户 Q1 加 owner 决定之后做；Y8 #6778 改同一 pairing 文件，后合入者 rebase；第 12 个输入键会改到封闭键测试。 |

关键路径：S6-1 → S6-2 → S6-3 / S6-4 → S6-9；S6-5、S6-6、S6-8 并行。必做 7 个（S6-1、S6-2、S6-3、S6-5、S6-6、S6-8、S6-9），S6-4 除非延后也要做，S6-7 视条件而定；合计约 1.5 万行（含测试），其中 4 个是 D4。规模是估算，不是实测。正文 §9.1 要求的启用前修补批（综合第 8 项 (a)–(g)）仍是翻转前置条件；其中 8(e)（重复幂等键的行拿不到 `expectedRecords`）按 R-91 的条件残留条款处理。

### 开发之外的瓶颈（owner 门，开发不能缩短）

启用任何试点都需要：打开批次开关（O-BI-7，就绪 v3 的 `pull_batch_enabled` 要求它）、试点表的装机 / 历史窗口（O-BI-1 / O-BI-8）、Q-B、指定拉取人员、试点项目（不是第 10 项那个项目）、现场事实（`specField`、客户包声明、第 ④ 步开关）、main 基线包与部署（gate 4），以及 R-63 ①、R-65、R-91 的否决窗口。Y8 合入后，再有 PR 给 `projectSpecModel` 加生产方，会让每张受治理表的机器摘要整体移动一次（Y8 自己的说明）；在翻转之后，这会强制重新结算。

---


Reviser: Opus 5.5, max effort, 2026-10-27 (Fable 5.1 is 429; owner fallback rule — every step-6 PR body says so). Read-only pass: the only file written is this one. Nothing in any worktree, the shared checkout or the R-line was modified.

Inputs, all read in full:
- the designer's `<private scratch: step-6 design v1>` (08:32, called **v1** below);
- the two refutations `<private scratch: refute-recovery>` (**RR**, 10 gaps) and `<private scratch: refute-deploy>` (**RD**, 10 gaps);
- the batch-identifier design `<private scratch: BI design v1>` (09:01, called **BI**). It is still at its design stage: its refuters and reviser have not run, so every clause of §4 below is a contract proposal routed through the coordinator, not a statement about BI's final text;
- the step-4 binding design `<private scratch: step-4 binding design>` (§9.3, §17 step-6 row, §23 F-11 / F-16 / D-22 / O-6 / O-7 / O-20, §23.9);
- the plan `docs/development/takeover-beiliao-20260821/batch-refresh-merge-plan-20261022.md` (§3.4, §5, §7, §8, §9, §10, §12);
- the remaining-work synthesis `<private scratch: remaining-work synthesis>` (items 3-11, risks 3-4);
- the coordinator log `<private coordinator log, 10-21 field feedback>` through line 137 (09:09), including three entries newer than both refutations: line 133 (owner: manual rows on project sheets), line 135 (R75 candidate; every later R-line backport is cut from R75), line 136 (PR-8 round-2 fixes in flight).

**Baselines.**
- `M:` = `origin/main` **5b9ec081b** (#6579), re-fetched 09:10, unchanged.
- `P8:` = the PR-8 branch head **c43238477** (local = remote, clean tree; read through a private read-only mirror). **PR-8 round 2 is in flight** (log line 136, <PR-8 round-2 workflow>: by-key reviewed-content compare, a hold on `!existingRow`, a bounded reviewed-cell register inside migration 104, the PR-4 continuation-confirm pilot check under the lock). None of it is committed yet. Every `CS` / `RL` / `RS` / `TA` / `AW` / 104 anchor below is re-anchored at PR-8's merged commit before 6a-1 starts (AGENTS.md 基线纪律); §13 names the exact re-checks.
- `R74:` = `onprem-r74` **f3efc86c0** (installed on site, log line 121). `R75` = R74 + #6315 + #6511 (log line 135, candidate verified, not shipped). Log line 135 makes R75 the base of every later R-line backport.
- `BI:` = the BI design v1 section numbers (private scratch).

Plugin paths are relative to `plugins/plugin-integration-core/lib/`. Abbreviations as in v1: `CS` continuation-store, `CP` continuation-pairing, `RL` refresh-lanes, `RS` refresh-state, `TA` table-actions, `AW` apply-writer, `LK` project-write-lock, `HR` http-routes, `RDY` pilot-readiness, `CSUP` continuation-support, `PT` project-targets, `PTS` project-target-store, `PLE` prep-line-export, `EG` export-gate, `AUD` audit-store, `WA` workbench-access; web `WAT` = `apps/web/src/services/integration/stockPreparation/workbenchAccess.ts`. Plan words: CP = the bound (confirmed) change plan, W0 = the pending written plan, RW = a recovery-written plan, Z = a zombie writer, R = the recovery. Synthetic names only (S, P, PART-A); no host, credential, project, drawing or person value appears here.

---

## 0. What changed from v1, and why (one screen)

**The blocker (RR G1, RD G1).** The owner decided on 2026-10-27 (log line 127, after v1 was written: v1 08:32, log entry 08:29-08:39) that 批次标识 goes to **all** projects, decoupled from the pilot, main first and then backported to the R maintenance line, with two columns — 首次批次 (the first batch in which the material appeared, carried across batches) and 本次拉取 (the batch of the pull that wrote the row). The log says verbatim: "This supersedes step-6 design item 6b-1's pilot-only model." The batch identifier was relaunched as its own workflow (<BI workflow>, log line 128), whose design is BI. v1's 6b model (governed-only, minted in the step-4 begin, carried on migration 103's execution row, install-gated per pilot sheet) cannot carry that decision: R74/R75 have no migration 100-104, no lease and no execution ledger (RD G1), non-governed and large-lane pulls never stamp (RR G1), and v1 §7.3(c) contradicted the owner's own example.

**So step 6 no longer designs the batch columns.** It depends on BI-1 (ledger, writer stamping, hash-neutral reader, readiness checks) merged on main, and on BI-2 (install + backfill) before the marker flip. There is ONE batch ledger: BI's.

**REMOVED from step 6** (each item now lives in BI or nowhere):
- v1 §4 (6b-1) and §5 (6b-2) in full; v1 migration 106 (`fpb_` ledger, registry `first_pull_*` columns, execution `first_pull_batch_id` / `first_pulled_at`);
- v1 T6-1 … T6-6, T6-13, T6-14 (the switch survives only renamed, for the 6d-2 repair, §6.6), T6-15's page name, T6-19's numbers, T6-20's version plan;
- the `…/target/first-pull` routes, the `sheet_maintenance` lock purpose, the `…/refresh/batches` route over `fpb_`;
- readiness `first_pull_store_readable`, `first_pull_columns_installed`, `first_pull_cells_complete`;
- the export columns (v1 T6-6) — the formal export is unchanged by step 6 (BI D-BI-13; owner item O-BI-6);
- the first-pull machine-band inclusion (v1 T6-5) — step 6 adopts BI's exclusion (§4.4);
- acceptance cases FP-*, FW-*, FO-*, FB-*, FE-*, FX-*, FI-*, SM-*, MF-*, S9B-*, S9I-* and every 6b mutant.

v1 §4.1's 422 analysis was verified correct by RD ("What holds") and is BI §3.2's rule now: no band id ever joins `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE`.

**KEPT, with fixes:** 6a (verify-and-close, self-verifying finish, derivation) — every RR gap closed in §3; 6c reduced to the executions list, a PULL-tier audited read of BI's ledger and the page (§5); 6d reshaped (§6): a census that also runs on R74/R75 as a read-only SQL pack, a remnant readiness check with an owner-recorded exit, repair tooling scheduled unconditionally with a DB-enforced one-shot claim, and the dropped-head ruling as the only conditional piece.

**NEW in this revision** (not in v1, not asked by a refuter, found while closing the gaps):
- the execution row records its begin-time source content digest, so a `landed` close of an execution that never allocated a batch can mirror BI's same-digest close rule (§3.2, §4.3);
- BI's `allocate()` has the same falsified premise RR G3 found in v1 ("ledger rows are touched only by lease holders"): a writer frozen before its first create allocates after a takeover on a stale in-lease read and can void or supersede the live writer's batch. Forwarded as contract clause C-6 (§4.2, §4.5);
- the owner's 10-27 manual-row decision (log line 133) is anticipated in the census and the classifier (§6.1, §3.5.1).

---

## 1. Decisions on one screen (T layer; register row **R-91** — PR-8 holds R-63, BI holds R-65 and R-90 belongs to the integration line; renumbered 2026-11-09, see the leading section — `Ratified-by-default-<publish date>` unless the owner vetoes within 24 h)

| # | Item | Decision |
|---|---|---|
| T6-1 | Recovery shape | Verify (values-free intent journal vs the sheet, plus a COMPLETE in-lease recompute) under a `recovery_verify` lease, then close in ONE plugin-db transaction that re-decides every admissibility fact under the state-row lock. Never a replay; the retry is a fresh preview and apply (§3.5-§3.6). |
| T6-2 | Intent journal | Written in the begin transaction of every governed execution, before the first write; values-free (digests, record-id handles, schema field ids, integers). The execution row also records `source_content_digest` (§3.2). |
| T6-3 | Self-verifying finish | `failed`/`aborted` with `written === 0 && attemptedWrites === 0` (integers) closes itself `verified_closed` / `nothing_landed` / `self_verified`. The best-effort failed finish qualifies only for an error carrying the writer-scoped marker `writerPhase === 'pre_io'`, never for `details.partial === false` (§3.3; RR G8). |
| T6-4 | A provably-nothing-landed result never destroys a confirmation | When a bound change plan is still `confirmed`, a self-verified finish and a puller close with result `nothing_landed` leave it `confirmed` (§3.3, §3.7; RR G2). |
| T6-5 | Transparency | Only a `nothing_landed` close of an execution NOT bound to a change plan is transparent to settlement. Stored as `settlement_subject = false` (CHECK-bound to that shape); a transparent close never writes the settled columns (§3.4; RR G2, G4). |
| T6-6 | Settlement subject read | The consult adds the newest 5 rows with `settlement_subject = true` per scope (equality WHERE). The derivation's subject is the newest settlement subject (§3.4; RR G4). |
| T6-7 | Tiers | `recover` and the executions list: `stock-prep:pull` (platform admin through the ladder). `close-unverified`: `stock-prep:admin`, owner runbook (§3.8). |
| T6-8 | `recovery_closed` bump | After release, awaited before the response, best effort. The fence that matters is the recovery's own takeover (epoch + 1); a failed bump is evidence-tested, not assumed harmless (S9R-27). |
| T6-9 | Plan-bound landed fields | The full (plan status × result × mode) table of §3.7 is binding, each cell with a test id. `landed` + CP `confirmed` → CP `written` (as a success); any other landed field → a recovery-written plan RW (new change-plan row, `written`) that absorbs W0. |
| T6-10 | The batch identifier | BI's (R-65). Step 6 mints no band field id, adds no export column, no install route, no band to any digest. Its only batch duties are the interface clauses C-1 … C-10 of §4. |
| T6-11 | Close transaction bounds | One lock order (§3.6). The close sets a 5 s `lock_timeout` once; 55P03 is classified by the step that raised it — only the lock-row step means `holder_in_write` (§3.6; RR G7). |
| T6-12 | Audit | Rides `exception_resolve` / `project_board_read` with new `mode` subtypes (D9 precedent; no vocabulary migration). |
| T6-13 | Migrations | 105 is BI-1's (it ships to the R-line). Step 6 takes the next free numbers, re-checked at publish: **106** (6a-1), **107** (6d-1b), **108** (6d-2a). Every migration follows 101's `DROP CONSTRAINT IF EXISTS` pattern and closes each `CREATE TABLE` body with `\n);` (§7; RD G9, RR G10). |
| T6-14 | Readiness versions | BI-1 takes v3. Then 6a-2 → v4, 6d-1b → v5, 6d-2b → v6 (only if built). A PR that lands out of this order takes the next version at merge (§8). |
| T6-15 | Page | The PULL-tier page is 「BOM 快照批次与差异」 in the 工作 group (plan §8; owner 2026-10-22, log line 57). Its default mode is the new one (batches from BI's ledger, executions, P↔S link); the legacy MVP-archive mode stays a platform-admin sub-mode. Recorded as an owner decision in the register before S6-4 (§5.3; RD G10). |
| T6-16 | Census | Rows-only, values-free. Public evidence (#6079) carries per-post ordinals and counts, never objectId handles; the ordinal↔handle map stays in the private record (§6.4; RD G4). It also ships as a read-only SQL pack that runs on R74/R75 (§6.4; RD G3). |
| T6-17 | Remnant readiness | `no_unacknowledged_inactive_root_remnant` refuses the item-10 shape unless an owner-recorded, values-free, per-component acknowledgement (or, once 6d-2b exists, a scoped ruling) exempts it (§6.5; RD G5). |
| T6-18 | Repair tooling | The retire/restore recipe, backup, preview, fills report and CI/dev rehearsal are an UNCONDITIONAL phase-1 PR (plan §12.1). A real run needs the env switch, the typed project, the preview `planDigest` echo, an `approvalRef`, and a DB-enforced one-shot claim on (sheet, project, recipe, planDigest) (§6.6; RD G6). Only the scoped dropped-head ruling waits for the customer's Q1 (§6.7). |
| T6-19 | Item-10 project | Still not the first pilot. It becomes pilotable after Q3 (fills) and either an acknowledgement (its old order head is no longer read: H0) or a scoped ruling (still read: H1) (§6.3). |
| T6-20 | Values | Q-B is not widened by step 6: the journal, the close, the census, the acknowledgement and the ruling are values-free; private values appear only in the audited verify pending page and the admin fills report, both of which read the sheet and persist nothing (§14.2 O6-9). |

---

## 2. Facts (verified on the stated baselines; v1's F6-1 … F6-27 that still matter are kept with their numbers, the rest are new)

### 2.1 Execution ledger, store, lanes (P8)
- F6-1 `CS:146-149` closed lists: `EXECUTION_STATUSES` includes `verified_closed`; `UNFINISHED_EXECUTION_STATUSES = running|partial|failed|aborted`; `VERIFIED_RESULTS = landed|nothing_landed|mixed|unknown`. No code writes `verified_closed` (F-16).
- F6-2 Migration 103 `refresh_execution` carries `verified_by`, `verified_at`, `verified_result`; CHECKs `(status='running') = (finished_at IS NULL)` and `(status='verified_closed') = (verified_at IS NOT NULL)`. Nothing stores the intended per-decision content today.
- F6-3 `CS:2710-2799` `beginExecution`: a plain begin is one `insertOne`; a change-plan-bound begin runs under the state-row lock and only **asserts** the plan `confirmed` (`CS:2785`) — it writes nothing to the plan row. The plan↔execution binding lives only in the execution's `refresh_binding.changePlanId`. **So a plan left `confirmed` can be bound again by a later begin** (used by T6-4).
- F6-4 `CS:2801-2958` `finishExecution`: CAS off `running` only (`CS:2832`, no lease check); a non-settling finish never takes the state row (`CS:2817-2821`); `succeeded` stamps bound continuations and turns the bound plan `written`, absorbing W0 (`CS:2915-2949`); any other status turns it `invalidated(execution_failed)` (`CS:2950-2958`).
- F6-5 `CS:1230-1238`: the consult reads the newest 5 executions per (sheet, project) and per (tenant, project) plus every unfinished one (`NEWEST_EXECUTIONS = 5`, `CS:204`); `selectLimited` takes an equality WHERE, `orderBy` and `limit` (`CS:1142-1148`).
- F6-6 `RL:392-405` `settlementForComputation` names the raw newest execution and requires it `succeeded|verified_closed`; `RL:371` `sourceContentDigestOf(dryRun)` = `TA.stockPreparationSourceContentDigest(dryRun.sourceContentRevision)` (`TA:1801`) — the same digest BI's small lane prefixes with `small:` (BI §2.5).
- F6-7 `TA:3245-3271`: the scoped API is built, then the governed begin, then the writer; `TA:2075-2086` `finishExecutionFailedBestEffort` records `failed` with `errorCodes` only (no `written` / `attemptedWrites`).
- F6-8 `AW:1068-1083`: a fence or version stop sets `abort`; `AW:1191-1196` `countAttemptedHostWrites` = written + failed host calls. A version-conflict stop at decision 0 ends `aborted / written 0 / attempted 0` — the PR-8 wedge W2.
- F6-9 `RS:218-251` derivation order: `executing` → `failed_pending_recovery` (any partial/failed/aborted, or `running` without a live lease, or an abandoned lease) → `pending_confirmation` → `change_pending_review` → `confirmed_pending_execution` (an unconsumed continuation, or a `confirmed` plan, `RS:236-243`) → `executed_pending_settlement` (newest `succeeded` not named by `settledExecutionId`, `RS:245-248`) → `complete`. `formalSurfaceVerdict` allows only `not_governed` and `complete ∧ settled` (`RS:270-277`). A `verified_closed` newest execution derives `complete` today.
- F6-10 `CS:2608-2662` the reconcile's plan verdict, under the state-row lock: `matches` keeps a `confirmed` plan (else 409 STALE); `stale` invalidates it `source_changed` with an audit row **unless an execution bound to it is `running`** (`CS:2633-2639`, read on the handle) — then the invalidation is deferred. A `verified_closed` bound execution does not defer it.
- F6-11 `CS:2169-2344` `confirmChangePlan` resolves the whole open content-hold set as `change_plan_confirmed` (`CS:2344`). From then on the pending change exists only as the `confirmed` plan; `CHANGE_PLAN_PENDING_STATUSES = ['confirmed','written']` (`CS:154`) is all the consult reads.
- F6-12 Migration 104 (`104_…sql:88-117`): status ∈ {confirmed, written, reviewed, invalidated, superseded}; `invalidated_reason` ∈ {source_changed, execution_failed}, and `execution_failed` requires `execution_id`; `written` requires `written_at` and `execution_id`; `write_record_count >= 1`; partial UNIQUE one `confirmed` and one `written` per (sheet, project). Every status after `confirmed` is terminal.

### 2.2 Lock (P8)
- F6-13 `LK:157-158` closed vocabularies (purposes `small_apply`, `large_apply_chunk`, `carry_confirm`, `pilot_enable`; reasons `small_preview`, `large_approval`, `carry_confirm`, `pilot_enable`, `continuation_confirm`, `continuation_end`, `change_plan_confirm`); no DB CHECK on them (migration 100); unknown tokens are 500 (`LK:270/277`); `readState` maps unknown tokens to null on rollback (`LK:883-899`, RD "What holds").
- F6-14 `LK:538-620` takeover of a lapsed lease = CAS with epoch + 1, bounded by `setLocalLockTimeout` inside its own one-UPDATE transaction (`updateBounded`, `LK:454-465`); 55P03 there → 409 `holder_in_write`. `LK:681` / `LK:832`: a holder cannot bump while it holds.
- F6-15 The host fence (I5): a takeover fences out a dead holder's not-yet-started host write and waits (bounded) for one in flight (`LK:52-62`, `plugin-write-fence.ts`).

### 2.3 Writer refusals before IO (P8)
- F6-16 Three writer refusals are raised before any host IO: the governance tripwire (`AW:952`, `{ reason, partial: false }`), `write_fence_required` (`AW:1015`, `{ reason }`), `host_fence_unsupported` (`AW:590`, `{ reason }`). `partial: false` is ALSO set by `writerStop` for "nothing of this decision" at any index (`AW:684-692`) and by LK for pre-write store operations and I3 refusals (`LK:249-263`, `LK:377-397`) — an overloaded flag (RR G8).

### 2.4 Planner, pairing, readiness (P8 / M)
- F6-17 `CP P8:291-297` `isActiveRow = active !== false`; `isRootRow = blank parentSourceId`. `RDY M:184-198` O-6 counts active rows only. `CP P8:1629-1665` `detectDroppedHeads` holds `dropped_order_head_unresolved` (`customer_rule_pending`, not confirmable) only for an observation with `source === 'order'` and a base-rule drop (`CP P8:1647`) when the component has no ACTIVE root row (`CP P8:1641-1650`).
- F6-18 The planner's sweep SKIPs a row already `active === false` whose key left the expansion (`conflict-planner P8:1844-1851`, `already_inactive`): no patch, no RUN stamp. A key that re-enters the expansion is revived by an ordinary UPDATE (BI F11, PL:1744-1748).
- F6-19 `RDY M:82` version 2; check ids `RDY M:102-121`; `CSUP M:21` `CONTINUATION_SUPPORT_VERSION: 0`.

### 2.5 Batch identifier (BI design v1, not yet implemented)
- F6-20 BI ledger = migration 105 (three tables `_sheet`, `pull_batch`, `pull_batch_execution`; BI §2.3); the link row carries `refresh_execution_id` when governed (BI §2.3, line 169) and `execution_ref = small:<lease runId> | large:<applyJobId>` (UNIQUE).
- F6-21 Allocation is lazy, in the writer's create leg, BEFORE `fenceBeforeWrite` (BI §2.4): the plugin-db transaction that opens/joins a batch commits before the lease CAS. Join iff the source digest equals the open batch's; otherwise the open batch is closed `superseded_by_new_source` or — main only, `voidReuse: 'in_lease'` — voided when no row of the in-lease read carries its label, its number then reused (BI §2.5).
- F6-22 BI `finish()` is best effort, keyed to the writer status: link updated, batch `created_row_count += createdCount`, closed on `succeeded`; a run that allocated nothing but succeeded closes a same-digest open batch `completed_by_later_execution` (BI §2.5).
- F6-23 BI's reader strips both band cells (physical and logical ids) onto `EXISTING_ROW_PULL_BATCH` before every revision (D-BI-6); the bands are excluded from compare, trigger, settlement, PR-8 `writtenBand` and the export (BI §3.3); the formal export is unchanged in v1 (D-BI-13).
- F6-24 BI readiness: `pull_batch_columns_present`, `pull_batch_ledger_readable`, `pull_batch_history_resolved`, `PILOT_READINESS_VERSION` 2 → 3 (BI §6.2). BI's status route is `stock-prep:admin`; its board stanza is operate-tier.

### 2.6 Doubled sheets, repair, census substrate (M / R74)
- F6-25 K2 `applyCarryViaConfirm` carries only `HUMAN_PRESERVED_FIELD_IDS`, needs the source row `active === false`, and refuses the whole row 409 when any target cell is non-blank and different (`confirm-writes M:766-781`). Admin-only, no UI (log line 59).
- F6-26 DB-enforced one-shot claim precedent: migration 078 + `b2a-trial-registry.cjs M:1018-1040` (PK insert, permanent, no TTL, no steal, fail-closed read-back).
- F6-27 Physical ids are `'fld_' || first 24 hex of sha1(projectId ':' objectId ':' logicalId)` and sheet ids `'sheet_' || …(projectId ':' objectId)` (`provisioning.ts:207-225`, identical on R74). The plugin's staging project id is `${tenantId}:integration-core` (`HR R74:1616`). R74 migrations 041 / 042a run `CREATE EXTENSION IF NOT EXISTS pgcrypto`, so `digest(…, 'sha1')` exists on the customer DB. Deleted records live in `meta_records_trash` (`zzzz20260617120000`), so `meta_records` holds live rows only. The registry (087, present on R74) carries `tenant_id`, `project_no`, `sheet_id`, `object_id`, `status`.
- F6-28 `scripts/ops/readonly-inventory-20260916/` is the precedent for a read-only `psql -f` pack (`_preamble.sql`, numbered files, `INVENTORY_RESULT … status=complete|incomplete`). Its CI lane `.github/workflows/ops-sql-pack-verify.yml` lists each pack in path filters and a matrix (`:56-115`): adding a pack there is a workflow edit, which the zensgit token cannot push (step-4 F42).
- F6-29 Plan U07 (`plan:308`) is phase-1 mandatory (`plan:236`); U04 (`plan:305`) requires paged complete evidence.
- F6-30 Owner 2026-10-27 (log line 133): manual rows on project sheets (per-sheet switch, default allowed; reserved key prefix and `created_by`; pulls never modify, inactivate or compare them; batch columns show 人工补充). Not implemented; it will land after step 6 starts.

---

## 3. 6a — recovery verify-and-close (F-16; step-4 §9.3 「失败待恢复 → 完成 only via recovery」; step-4 §17 step-6 row)

### 3.1 What is broken today
1. **W1 — any unfinished execution wedges a governed project.** A `partial` / `failed` / `aborted` row, or a `running` row without a live lease: every governed apply and the carry lane answer 409 RECOVERY_PENDING, every continuation and change-plan decision is refused under the state lock, the preview mints nothing (`recovery_pending`), and the formal export is refused (失败待恢复). Only an owner-approved DB operation ends it (F6-9, step-4 F-16).
2. **W2 — the PR-8 version-fence stop with nothing written.** A machine column of a planned row moves between preview and apply; decision 0 stops `machine_columns_moved`; the run ends `aborted / written 0 / attempted 0` (F6-8) and W1 wedges it although provably nothing landed.
3. **The missing ingredient.** Nothing stores the intended per-decision content (F6-2), so a recompute alone cannot tell 「未写」 from 「已写且可核实」 from 「被后来操作改变」 (plan §5.2, E05, E08).

### 3.2 6a-1 — the execution intent journal (written before the first write)
**Storage (migration 106, §7.2).** Table `integration_stock_prep_refresh_execution_intent`, primary key `(execution_id, chunk_index)`, scope columns, `entry_count` (1..2000), `entries JSONB`, `fieldsets JSONB`; values-free; never deleted. The execution row gains `intent_version`, `intent_digest`, `intent_entry_count` (NULL together) and **`source_content_digest`** (`RL.sourceContentDigestOf(dryRun)` of the in-lease recompute, F6-6 — a 32-hex digest, values-free). The consult never reads the intent table, so a database without 106 breaks only governed applies (§7.4).

**When.** `beginExecution` (`CS:2710`) becomes ONE transaction for every governed begin:
1. `[state row FOR UPDATE]` — only when plan-bound (as today);
2. `[change plan FOR UPDATE]` — only when plan-bound (as today; asserted `confirmed`);
3. `INSERT execution` (`intent_*`, `source_content_digest` set);
4. `INSERT intent chunks`.

There is no batch step: BI allocates lazily inside the writer, after the begin (F6-21). A failure anywhere means no execution row and no write; the apply refuses `partial: false` (`TA:3249-3251`, P3-X3). v1's sentence "batch allocation does not need the state row, because batch rows are only touched by lease holders" is withdrawn (RR G3: false premise; §3.9).

**One entry** per ADD / UPDATE / INACTIVE decision of `dryRun.plan.decisions` (the exact list the writer receives, controlled updates included); SKIP and MANUAL_CONFIRM get none.
```
{ i: <decision index>, d: 'a' | 'u' | 'x',
  k: <sha256('stock-preparation/intent-key/v1' | idempotencyKey) first 32 hex>,
  r: <expected record id | null>, v: <expected version | null>,       // UPDATE / INACTIVE: from expectedRecordsOf (TA:2048-2068)
  f: <index into the chunk's fieldsets>,                              // sorted schema field ids compared (values-free)
  pre: <bandDigest(expected row, fields) | null>,                     // null for ADD and for an UPDATE with no expectedRecords entry
  post: <bandDigest(decision record / patch, fields)> }
bandDigest(src, fields) = sha256(canonicalJson({ scheme: 'stock-preparation/intent-band/v1',
                          cells: fields.map((id) => [id, canonicalChangeValue(src[id], templateFieldOf(id))]) })).slice(0, 32)
intent_digest = sha256(canonicalJson({ scheme: 'stock-preparation/execution-intent/v1', planDigest, entries, fieldsets }))
```
**Compared fields** = the keys the decision writes (`record` for ADD, `patch` for UPDATE / INACTIVE) ∩ the pack-aware plm writable band (`AW:987-994`, the writer's own band). Left out by construction:
- RUN fields (no business content; unproven date round-trip);
- BI's band ids — they are neither template nor `ext_` ids, so they are never in the pack-aware band (BI §3.3), and BI's writer adds them to the create leg's `data` AFTER mapping, never to the decision's `record` / `patch` (BI §2.4). XI-02 asserts no fieldset ever contains a BI band id, logical or physical;
- human columns (structurally absent).

Canonicalisation is PR-8's `canonicalChangeValue` (`CP:2205`), already proven to make plan-time and read-back values compare equal (review digests).

**Builder.** Pure `buildExecutionIntent({ plan, expectedRecords, templateFields, plmWritableFieldIds })` in the new `lib/stock-preparation-execution-intent.cjs` (which also holds the classifier). Called by the apply lib between the scoped-API build (`TA:3245`) and the begin (`TA:3252`), from the in-lease recompute only (O-10); passed as `beginExecution({ …, intent: { version: 1, entries, fieldsets, digest }, sourceContentDigest })`. The store refuses a governed begin without both: 500 `STOCK_PREP_REFRESH_INPUT_INVALID` before any statement.

**Values-free by construction**, pinned by a sentinel suite (XI-02). **C09:** a not-governed apply begins no execution, so no journal; byte identity holds (G-01).

### 3.3 6a-1 — the self-verifying finish (closes W2 without a person)
In `finishExecution` (`CS:2801`):
- **Condition.** `input.status ∈ {failed, aborted}`, `Number.isInteger(input.written) && input.written === 0`, `Number.isInteger(input.attemptedWrites) && input.attemptedWrites === 0`.
- **The row** moves to `verified_closed` with `verified_result = 'nothing_landed'`, `closed_mode = 'self_verified'`, `pre_close_status = input.status`, `finished_at = verified_at = now`, `verified_by = NULL`, `verify_summary = { selfVerified: true, abortCode?, decisionCount }`, the counts and codes a failed finish records, and `settlement_subject = (bound to a change plan)` — false for an unbound run (transparent, §3.4), true for a plan-bound one.
- **The bound change plan (T6-4, RR G2).** If CP is `confirmed` it **stays `confirmed`** (asserted under its row lock, not updated). Nothing landed, so the confirm's authorisation is intact; the next reconcile either `matches` it (a fresh preview mints, the next apply binds CP again — F6-3) or invalidates it `source_changed` atomically with the new holds (F6-10). W0 is untouched; no RW (nothing landed). v1's "side effects of the failed finish (CP invalidated)" is withdrawn: it destroyed the only record of a confirmed change and let the project derive 已完成 with pre-change content (RR G2).
- **Continuations** are not stamped (not a success); an unconsumed continuation keeps deriving 已确认待执行.
- **BI ledger:** nothing. BI's own `finish()` runs in the apply lib (C-5).
- **Why it is provable.** `countAttemptedHostWrites` counts every confirmed write and every host call that raised (`AW:1191-1196`); a fence or version stop happens before the host call or is a host refusal inside the host's own write transaction (`AW:1068-1083`). Zero attempts means no `createRecord` / `patchRecord` returned or raised, so nothing was committed (RR "What survives" (4)).
- **The best-effort failed finish** (`TA:2075-2086`) passes `written: 0, attemptedWrites: 0` **only** when the thrown error carries `error.writerPhase === 'pre_io'`. The writer sets that marker at exactly its three pre-loop refusals (F6-16) — the governance tripwire, `write_fence_required`, `host_fence_unsupported` — and nowhere else; `WRITER_PRE_IO_REASONS` is an exported closed list, pinned by XS-03. `details.partial === false` alone **never** qualifies: `writerStop` and LK use it with other meanings (F6-16, RR G8), so a future rethrow of a mid-run stop would otherwise self-verify a run that landed rows.
- **Never self-verified:** `partial`; any `attemptedWrites > 0`; `attemptedWrites` absent or null; a throw without `writerPhase === 'pre_io'` (for example `metadata_scope_incomplete`, which fires after the loop, `AW:1158`); a finish that itself failed (the row stays `running`; 6a-2 recovers it).
- **Audit.** `exception_resolve`, mode `execution_self_verified`, actor NULL, appended inside the finish transaction when the governance handle wires an audit hook. `refreshGovernanceFor`'s `auditWithin` (`HR P8:4831-4862`) is generalised to an event kind (`change_plan_invalidated` | `execution_self_verified`) with a closed mode map; PR-8's `change_plan_invalidated` row stays byte-identical (CP-S08 / S8-03 green). With no hook wired the finish is not refused (provable bookkeeping).
- **Behaviour change against PR-8 (tripwire).** PR-8 suites that pin `invalidated(execution_failed)` for a zero-attempt bound stop (the S8-04c W2 harness family) are re-pinned in S6-1 to `confirmed` + `verified_closed / self_verified`. S6-1's body lists each re-pinned assertion.

### 3.4 6a-1 — derivation and consult (a closed execution must not read 已完成 without a settlement that names it)
- **Stored subject flag (migration 106).** `settlement_subject BOOLEAN NOT NULL DEFAULT true`. Every existing row reads `true` (fail-safe: a legacy row is never transparent). Only a **transparent close** writes `false`, and a CHECK binds that value to its shape: `settlement_subject OR (status = 'verified_closed' AND verified_result = 'nothing_landed' AND (refresh_binding->>'changePlanId') IS NULL)`.
- **`RS`.** `isTransparentExecution(e) = e.settlementSubject === false`; `normalizeConsult` treats `settlementSubject === false` on any other shape as malformed (→ `unreadable`, fail closed). `newestSettlementSubject(executions) = newestExecution(executions.filter((e) => e.settlementSubject !== false))`. Both exported; the ONE definition (lanes and the export gate import it).
- **`RS:245-248`** becomes: the newest settlement subject is `succeeded` **or `verified_closed`** and `state.settledExecutionId` does not name it ⇒ `executed_pending_settlement`.
- **`RL:392-405` `settlementForComputation`**: admissible when the raw newest execution is absent, `succeeded` or `verified_closed` (no settlement while anything is unfinished, unchanged), and it names `newestSettlementSubject(consult.executions)`, never the raw newest.
- **`CS:1230-1238`** adds, per scope, `selectLimited(snapshot, T.execution, { where: { ...bySheetProject, settlement_subject: true }, orderBy: ['started_at', 'DESC'], limit: NEWEST_EXECUTIONS })` and its (tenant, project) twin. The newest settlement subject is therefore always in the consult however many transparent closes follow it — including a `verified_closed` subject, which v1's "newest 5 succeeded + newest 5 verified_closed" could not protect (RR G4: transparent closes are themselves `verified_closed`). `rowToExecution` exposes `settlementSubject`, `verifiedResult`, `closedMode` and a boolean `changePlanBound`.
- **A transparent close never writes the settled columns** (RR G4 claim 2): it is not a subject, and the previous subject's settlement still names the previous subject.
- **Effects (v1's §3.4 "Effect" sentence is withdrawn and replaced):**

| close | derived state afterwards | export |
|---|---|---|
| not plan-bound, `nothing_landed` (self-verified or puller) | exactly as before the attempt (transparent; no confirmation existed that the attempt consumed — unconsumed continuations stay unconsumed) | as before |
| plan-bound, `nothing_landed`, CP left `confirmed` (T6-4) | 已确认待执行 (`RS:243`), until the next reconcile matches (re-apply) or invalidates CP with new holds (F6-10) | 409 |
| plan-bound, `nothing_landed`, CP already `invalidated(execution_failed)` by an earlier finish (terminal, F6-12) | the close is a settlement subject ⇒ 已执行待核对; the next pilot computation raises `content_change` for the unapplied change, because no pending plan covers it any more (F6-11) ⇒ 待确认 | 409 |
| `landed` / `mixed` | 已执行待核对 unless the close self-settled (§3.6 step 7); RW, when written, makes it 变更待复核 first | 409 until settled / reviewed |
| `unknown` (runbook) | 已执行待核对 (never self-settles) | 409 |

### 3.5 6a-2 — the recovery operation (the puller-reachable entry; G4 「恢复入口」)
**Routes** (rows of `STOCK_PREP_WORKBENCH_CAPABILITIES`, `WA:135`, with control ids and web mirrors):

| route | tier | purpose |
|---|---|---|
| `GET …/projects/:projectNo/refresh/executions?limit≤20&cursor` | `stock-prep:pull` | Values-free list, newest first (§5.1). |
| `POST …/projects/:projectNo/refresh/executions/:executionId/recover` | `stock-prep:pull` | Body `{ tenantId?, confirmProjectNo, mode: 'verify'\|'close', verifyDigest?, pageCursor? }`. `confirmProjectNo` typed in both modes (both take the lease and read the source); `verifyDigest` required iff `close`; `pageCursor` only in `verify`. |
| `POST …/projects/:projectNo/refresh/executions/:executionId/close-unverified` | `stock-prep:admin` | The runbook escape (§3.8). Body `{ tenantId?, confirmProjectNo, mode: 'inspect'\|'close', inspectDigest?, runbookRef?, acknowledge? }`. |

Tier semantics come from the PR-4 decision context (`HR:4773-4826`): tenant from the host-vouched operator scope with `requiredTier` (a tenantless platform admin gets 403); the project from the path; the sheet from the overlay with `targetPurpose: 'write'` (archived ⇒ 409 ARCHIVED: restore first; the unfinished row keeps the export blocked meanwhile); `assertResolvedProjectTargetTenancy`; `requireStockPreparationAuditVocabulary` probes every action the route appends. The floor (`read ∧ operate` without pull) gets 403 on all three. The scheduled pull never recovers (G1 「能用本人账号确认和恢复」).

**Order of operations for `recover`** (fixed; a call-order fake pins it, RV-01):
1. **Prelude**: gate, body allow-list (`VALID_STOCK_PREPARATION_REFRESH_RECOVER_KEYS`), typed project, decision context. Early advisory refusals: 404 `STOCK_PREP_REFRESH_EXECUTION_NOT_FOUND` (also for an id of another scope — never an existence oracle), 409 `STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED`.
2. **Lease**: `withProjectWriteLease(sheetWriteScopeKey(sheetId), { purpose: 'recovery_verify', runId: b2aRunId('refresh-recover'), tenantId }, fn)`. A live writer ⇒ 409 WRITE_LOCKED (`retryAfterMs`); an abandoned lease is taken over (epoch + 1); a dead writer's not-yet-started host write is then refused by the host fence, and one frozen inside its write transaction is waited for up to the 5 s bound, else 409 `holder_in_write`. From here no plugin **host** writer can change the sheet until release (I1, I5). Plugin-db ledger writes by a zombie are NOT fenced by this (§3.9 rows 3, 11, 12).
3. **B2a and the source adapter**, as the apply does (`HR:8466-8476`).
4. **`recoverStockPreparationExecution(input)`** in `TA` beside the apply (it needs the module-internal `computeDryRun`); requires and scope-checks the guard; performs **no record write**.
   - a. **Read.** `handle.store.readExecutionForRecovery({ tenantId, sheetId, projectNo, executionId })`, one REPEATABLE READ read: the execution row (106 columns), the intent chunks (contiguous `chunk_index`, `Σ entry_count = intent_entry_count`, recomputed digest equal, else `intent_corrupt`), the bound CP row (PRIVATE `record_set`, `CS` only) and W0. Then the BI link of this execution through the route-wired reader `readBatchLink({ refreshExecutionId })` (C-2; values-free). Unfinished required (409 NOT_UNFINISHED), in scope (404 otherwise). The handle facade (`RL:763`) gains `readExecutionForRecovery`, `closeExecution`, `listExecutions`.
   - b. **Recompute under the lease**: `computeDryRun({ … })` with the in-lease consult, the source read and the project-scoped existing-row read with record refs **and BI's `pullBatchBand`** (BI §3.4 requires every `computeDryRun`-reaching route to pass it; its source-scan tripwire covers this new route). Not reconciled: no new computation lane, so 103's `last_computation_lane` / `opened_lane` CHECKs are untouched. `dryRun.refresh.governed === true` (invariant; breach 500) and `dryRun.refresh.complete === true` (else 409 `STOCK_PREP_REFRESH_RECOVERY_RECOMPUTE_INCOMPLETE`; a store or source failure passes through as 503). Nothing is closed in either case.
   - c. **Classify** (§3.5.1) over `dryRun.existingRows` — the recompute's own read under the lease IS the sheet state.
   - d. **Consistency**: no entry `d:'a'` classified `landed` may reappear as an ADD of the recompute (key-digest equality), else `recompute_disagrees` (defect detector).
   - e. **Plan-bound mapping**: each write record of CP maps to the class of its UPDATE entry (`r === recordId`); a write record with no entry is classified from CP's own `record_set` (`landed` if `canonicalChangeValue` equals `afterCanonical` for every write field; `not_landed` if it equals `before`; else `diverged`) — the comparison `currentContentDigestOf` makes at review (`CP P8:2233`).
   - f. **Report and `verifyDigest`** (§3.5.2).
   - g. **`verify`** answers the report plus ONE page of the private pending list. **`close`**: refusal reasons ⇒ 409 `STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE`; echoed `verifyDigest` ≠ recomputed ⇒ 409 `STOCK_PREP_REFRESH_RECOVERY_STALE`; the settlement candidate (§3.6 step 7); then `handle.store.closeExecution(…, { auditWithin, holderWithin, batchWithin })` (§3.6).
5. **Release** (finally). If closed: `await projectWriteLock.bumpGeneration(scope, { reason: 'recovery_closed', tenantId })`; a failure is logged values-free and never turns the close into an error (T6-8). Awaited before the response; the response carries `generationBumped: boolean`.
6. **Audit and respond.** In `verify` mode each answered page is audited first (`project_board_read`, mode `execution_verify_read`, page index and counts); a refusing audit means no values are sent (B-04 posture). The `close` response reports the outcomes **decided under the locks** (`preStatus`, plan outcome, batch outcome, `settled`), never an echo of the verify report — `verifyDigest` binds the classification only (RR "What survives" (3)).

**The private pending list is paged (U04, RD G8).** Entries `not_landed` or unprovable, ordered by decision index, 200 per page, `pageCursor` = the last decision index of the previous page (values-free). Each entry is joined by key digest to the recompute's expansion rows (`componentCode`, `componentName`, decision kind, class; a key no longer in the source shows 「源中已无」). `close` does not require every page to have been read: this is bookkeeping about what the system did, not a business confirmation; `verifyDigest` binds the close to the full classification.

#### 3.5.1 The classifier (pure)
`rows` are indexed by the key digest of `row.idempotencyKey` (the scheme of `k`). Per entry:

| entry | rows with that key | condition | class |
|---|---|---|---|
| ADD `a` | 0 | — | `not_landed` |
| ADD `a` | 1 | `bandDigest(row, f) === post` | `landed` |
| ADD `a` | 1 | otherwise | `diverged` |
| any | ≥ 2 | — | `duplicate` |
| UPDATE / INACTIVE | 0 | — | `vanished` |
| UPDATE / INACTIVE | 1 | `r !== null && ref.id !== r` | `replaced` |
| UPDATE / INACTIVE | 1 | `bandDigest === post` | `landed` |
| UPDATE / INACTIVE | 1 | `bandDigest === pre` | `not_landed` |
| UPDATE / INACTIVE | 1 | otherwise, or `pre === null` and ≠ post | `diverged` |

Result: all `landed` ⇒ `landed`; all `not_landed` (or zero entries) ⇒ `nothing_landed`; only `landed` and `not_landed` ⇒ `mixed`; anything else ⇒ **unprovable** with reasons ⊂ {`duplicate_rows`, `record_vanished`, `record_replaced`, `diverged`}. Raised outside the classifier: `intent_missing` (a legacy row with `intent_version` NULL), `intent_corrupt`, `recompute_disagrees`. `landed` is decided by **content equality on the compared band**, never by key or record id alone (E08).

Manual rows (F6-30, once that feature lands) carry a reserved key prefix the planner never plans, so they can never share a key digest with an intent entry; the classifier needs no change. A hermetic case is added by the manual-row PR, not by step 6.

#### 3.5.2 The report (values-free) and the digest
```
{ executionId, preStatus, result: 'landed'|'nothing_landed'|'mixed'|'unprovable',
  counts: { intended, landed, notLanded, diverged, duplicate, vanished, replaced },
  byKind: { add: {…}, update: {…}, inactive: {…} },
  refusalReasons: [...], closeAdmissible: boolean,
  remaining: { add, update, inactive, manualConfirm, suspended: boolean, holdCount },      // from the recompute
  settlesIfClosedNow: boolean,
  changePlan: { bound, planStatusSeen, landedRecords, notLandedRecords, possiblyLandedRecords, writtenPlanPending } | null,
  batch: { linked: boolean, batchNo, statusSeen, verifiedCreatedRows } | null,              // BI link (C-2); ordinal only
  pending: { total, pageCount },
  verifyDigest }
verifyDigest = sha256(canonicalJson({ scheme: 'stock-preparation/recovery-verify/v2', executionId, intentDigest, result, counts,
                 landedRecordIds (sorted), possiblyLandedRecordIds (sorted), landedAddCount, verifiedCreatedRows,
                 rowsDigest: sha256 over [k, recordId, bandDigest] of every intended key's current row(s), sorted }))
```
`verifiedCreatedRows` = the number of landed ADD entries whose current row's 本次拉取 cell (read from BI's `EXISTING_ROW_PULL_BATCH` Symbol, F6-23) equals the linked batch's label: rows this execution provably created into that batch, derived from the sheet, never accumulated (RR G3). 0 when no link or when BI is not installed on the sheet.

### 3.6 The close transaction (`CS.closeExecution`; every admissibility fact decided under the locks)
One `db.transaction` while the recovery holds its lease. Input: scope, `executionId`, `mode: 'puller_verified' | 'runbook'`, the classification (result, intent digest, counts, landed and possibly-landed record ids, `landedAddCount`, `verifiedCreatedRows`), the lease facts `{ leaseId, fencingEpoch, leaseRunId, scopeKey }`, an optional settlement, `closedBy`, `runbookRef` (runbook only). Callbacks: `auditWithin` (AUD `appendWithin`), `holderWithin` (new `LK.assertHolderWithin`), `batchWithin` (BI store, C-3; absent ⇒ no BI step, for a deployment where BI-1 has not merged — impossible after §13's order, kept fail-safe).

**Lock order** (extends `CS:43-57`; every other step-4/5 transaction that takes both the state row and the lock row takes the state row first, so no two can cycle — RR "What survives" (1)):
0. **Bound first:** `SET LOCAL lock_timeout = PROJECT_WRITE_ROW_LOCK_WAIT_MS` as the transaction's first statement, so the state-row wait of step 1 is bounded too (`holderWithin` re-sets the same value idempotently). 55P03 at step 1 ⇒ `RECOVERY_BUSY { step: 'state_row' }`.
1. **Refresh-state row FOR UPDATE** (`lockStateRow`, `CS:1390`). Absent ⇒ 409 STATE_MOVED `state_row_absent`.
2. **Lock row FOR UPDATE via `holderWithin(trx, scopeKey, { leaseId, fencingEpoch })`.** It runs `SET LOCAL lock_timeout = PROJECT_WRITE_ROW_LOCK_WAIT_MS`, which stays in force for the rest of this transaction (documented on the method), then `selectOneForUpdate(lock table, { scope_key })`, and requires `lease_id === leaseId && fencing_epoch === fencingEpoch`, else 409 `STOCK_PREP_PROJECT_WRITE_LEASE_LOST` (`recovery_lease_lost`) and rollback. It reads and locks, never writes; I1-I5 unchanged. The close commits only while R still holds the lease; a takeover's UPDATE waits behind this row lock.
3. **Execution row FOR UPDATE.** In scope (tenant assertion); status ∈ `UNFINISHED_EXECUTION_STATUSES`, else `succeeded` ⇒ 409 NOT_UNFINISHED `execution_finished`, `verified_closed` ⇒ 409 NOT_UNFINISHED `verified_closed`. Puller mode: `intent_digest` equal to the input's. `pre_close_status` = the status seen HERE (a zombie may have moved `running` → `aborted` since the verification; admissible, §3.9).
4. **Bound continuations**, ascending id, FOR UPDATE — only for `landed`. Each `claim_active` at the bound revision, as a succeeded finish (`CS:2852-2873`); a miss ⇒ 409 STATE_MOVED.
5. **CP and W0 FOR UPDATE**, then the cell of §3.7 (CP update, W0 supersede, RW insert).
6. **BI: `batchWithin(trx, { scope, refreshExecutionId, result, verifiedCreatedRows, sourceDigest: 'small:' + execution.source_content_digest })`** — the BI link row(s) then the batch row, FOR UPDATE, per C-3 / C-4. Absent link and no same-digest open batch ⇒ no-op. The outcome (`none | kept_open | closed | already_closed`) goes to the audit detail and the response.
7. **Settlement** — only when this close is a settlement subject (not transparent) AND the input carries one AND, re-read under the state lock: zero open holds (`openHoldsOf`, `CS:1419`), no other unfinished execution, the state row's `settled_*` not newer than this execution's start. The input carries one only when the recompute was clean (`plan.suspended !== true`, no holds), `pendingDecisionCount(plan) === 0` (`RL:381`) and the result is not `unknown`. Writes `settled_at`, `settled_execution_id = executionId`, `settled_generation_token = guard.generationToken`, `settled_source_content_digest`, `settled_sheet_machine_digest` (the SAME `machineDigestOf` over `dryRun.existingRows`, `RL:375-379`; BI's band is excluded by construction, §4.4).
8. **Execution UPDATE**, CAS on `{ id, status: <seen in step 3> }`: `status = 'verified_closed'`, `verified_result`, `verified_at = now`, `verified_by = closedBy`, `closed_mode`, `pre_close_status`, `verify_summary` (counts, values-free), `verify_lease_run_id`, `verify_fencing_epoch`, `runbook_ref`, `settlement_subject` (`false` iff the transparent shape of §3.4), `finished_at = COALESCE(finished_at, now)`.
9. **State row `decision_version + 1`, `version + 1`**: the close changes decision-relevant facts (plans, consumed continuations), so a reconciliation that straddled it is refused 409 STATE_MOVED.
10. **`auditWithin`**: `exception_resolve`, mode `execution_verified_closed` (puller) or `execution_closed_unverified` (runbook); `subject_id` = the execution id; `detail = { operation, result, preStatus, counts, changePlanOutcome, batchOutcome, settled }`. An audit failure rolls everything back (E09).
11. **COMMIT**; a COMMIT failure is 503 STORE_FAILED `commit`.

**55P03 by step (RR G7).** The close tags each step before its statements. 55P03 at step 2 ⇒ 409 WRITE_LOCKED `holder_in_write`. 55P03 at step 1 or at steps 3-10 (the state row a reconcile holds, the execution row a zombie finish holds, continuations, plans, BI rows, the state UPDATE, the audit insert) ⇒ rollback and 409 **`STOCK_PREP_REFRESH_RECOVERY_BUSY`** `{ step }` (new code, retryable, `retryAfterMs`). Any other SQL failure ⇒ 503 STORE_FAILED with the step. RC-07 drives a 55P03 at each step and pins the code.

**Side effects by result** (non-plan-bound columns; plan-bound cells in §3.7):

| result | continuations | BI batch (C-3/C-4) | settlement | `settlement_subject` |
|---|---|---|---|---|
| `landed` | stamped `executed_execution_id = id` (as a success) | linked batch closed if open; same-digest open batch closed if no link | if clean | true |
| `mixed` | untouched (the next successful apply consumes them) | kept open (a same-digest retry joins it); link count set by value | if clean | true |
| `nothing_landed` | untouched | kept open; link count set by value (normally 0) | never (transparent) | **false** |
| `unknown` (runbook) | untouched | kept open; link count from the sheet-only count | never | true |

The recovery **never voids** a batch: BI's own label-scan rule decides at the next allocation (F6-21).

### 3.7 Plan-bound executions — every cell (RR G2, G9; B1 trace 3)
Rows are keyed by the plan status seen **under the step-5 lock**; there is no "any" row, so no two rows overlap. `RW` = a new `integration_stock_prep_change_plan` row inserted `written` (layout below); "absorb W0" = W0 superseded first, then its unreviewed fields folded into the written plan review-only (the succeeded finish's order and helper, refactored into one shared `writePlanWithin(trx, …)`).

| # | CP status under the lock | result | mode | CP | RW | W0 | close is a settlement subject | test ids |
|---|---|---|---|---|---|---|---|---|
| P1 | `confirmed` (run died `running`) | `landed` | puller | → `written` (as `CS:2915-2949`) | — | absorbed into CP | yes | RC-04a, S9R-18 |
| P2 | `confirmed` | `mixed` | puller | → `invalidated(execution_failed)`, `execution_id` = this | RW(landed records) | absorbed into RW | yes | RC-04b, S9R-18 |
| P3 | `confirmed` | `nothing_landed` | puller | **stays `confirmed`** | — | untouched | yes (not transparent) | RC-04c, S9R-23 |
| P4 | `confirmed` | `nothing_landed` | self_verified (finish) | **stays `confirmed`** | — | untouched | yes | XS-02b, S9R-01b |
| P5 | `confirmed` | `unknown` | runbook | → `invalidated(execution_failed)` FIRST | RW(**every** write record, fail-safe) | absorbed into RW | yes | RC-04d, S9R-20b |
| P6 | `invalidated(execution_failed)` (the finish ran) | `landed` | puller | unchanged (terminal) | RW(every write record — all landed) | absorbed into RW | yes | RC-04e, S9R-16b |
| P7 | `invalidated(execution_failed)` | `mixed` | puller | unchanged | RW(landed records) | absorbed into RW | yes | RC-04f, S9R-16 |
| P8 | `invalidated(execution_failed)` | `nothing_landed` | puller | unchanged | — | untouched | **yes** (⇒ 已执行待核对; the next computation reopens the content hold) | RC-04g, S9R-24 |
| P9 | `invalidated(execution_failed)` | `unknown` | runbook | unchanged | RW(every write record) | absorbed into RW | yes | RC-04h, S9R-20 |
| P10 | `invalidated(source_changed)` | any | any | — | — | — | 409 STATE_MOVED `change_plan_moved` (unreachable: the reconcile defers while the bound execution is `running`, F6-10, and a non-running bound execution's finish already chose `execution_failed`) | RC-04i |
| P11 | `written` / `reviewed` / `superseded` / absent | any | any | — | — | — | 409 STATE_MOVED `change_plan_moved` (defect, never silent: CP leaves `confirmed` only through its own bound execution's finish, which cannot run while this one is unfinished) | RC-04j |
| P12 | `invalidated(execution_failed)` | `nothing_landed` | self_verified | — | — | — | unreachable: self-verification happens in the finish, which chooses P4 instead of invalidating | XS-02c (assert the finish never invalidates on the 0/0 path) |

An RW is written only when it has ≥ 1 write record (104's `write_record_count >= 1`); a P2/P7 with zero landed write records writes none.

**RW layout:** `record_set` = CP's records restricted to the landed (P2, P7) or all (P5, P6, P9) write record ids, baselines kept, then W0's unreviewed fields folded in review-only; `execution_id` = the closed execution; `written_at = now`; `written_content_digest = plannedContentDigestOf(record_set)`; `plan_fingerprint` = `changePlanFingerprintOf` over the subset with scheme `stock-preparation/change-plan-recovered/v1`; copied from CP: `source_content_digest`, `planned_content_digest`, `hold_ids`, `hold_set_fingerprint`, `continuation_ids`, `review_baseline_digest`, `confirmed_*`; new nullable column `recovered_from_change_plan_id` = CP's id (migration 106). 104's partial unique "one `written` per (sheet, project)" holds because W0 is superseded first, in the same transaction.

**After an RW close** the project derives 变更待复核 and the export is refused (C04). The review (PR-8 route; PR-9 UI) treats RW as any written plan and shows one flag line 「这些改动在一次未完成的写入中已写入表格」. RW's records hold on-sheet values, so the review can complete; the not-landed records still differ from the source, so the next pilot computation holds them `content_change`, the puller confirms CP2, and CP2's success absorbs RW (PR-8 B1 option (ii)). For P5/P9 (`unknown`), fields that did not land keep RW's review stale (`content_moved`) until the next computation holds them and a new plan's write absorbs RW — PR-8's existing residual path, no new dead end. PR-8 round 2's bounded reviewed-cell register (log line 136) is written by the review path, so it covers RW's reviewed cells with no step-6 code; S6-2 re-checks this at PR-8's merged head.

**C03 recovery leg** (中途失败 / 提交后响应丢失 → 恢复后结果核对一致，不重复写、不以旧计划覆盖新值): the close writes nothing to the sheet, and the remaining update is recomputed from the current source and sheet under a fresh confirm (S9R-16). **C08** (接受变更 → 写入失败 → 恢复 → 复核 → 导出放行 → 再次变化使复核失效): S9R-17 on PostgreSQL.

### 3.8 When the landed rows do NOT match the intent — stay failed, then the runbook
- **The puller close refuses** 409 `STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE` `{ reasons, counts, partial: false }`; the row stays unfinished; 失败待恢复, export 409, apply 409 RECOVERY_PENDING (plan §5.2 「无法证明结果：保持失败待恢复」).
- **The runbook** (owner-approved; appendix B.4 of `runbook-stock-prep-project-sheets-switch-on-20261014.md`, carried by the docs PR S6-8):
  1. read the verify report and every page of the pending list;
  2. `duplicate_rows`: specialist repair — a platform admin removes the duplicate per the customer's choice through the multitable UI, under the owner's approval for that sheet;
  3. `record_vanished` / `record_replaced`: a person deleted or re-created a row; record it; the close is still safe (the next computation re-plans the row; PR-8 round 2's "hold on `!existingRow`" keeps a reviewed row's re-ADD held);
  4. `diverged`: a machine column was written outside the plugin (an automation) — disable that automation first (step-4 §22 risk 1);
  5. `intent_missing`: a legacy execution begun before 6a-1 (none can exist on a customer host: no project is governed before the flip; dev/CI only);
  6. then an admin runs `close-unverified`: `inspect` runs inside the recovery lease with the sheet read only and **no source read** (the escape must work when the source cannot be read), classifies best-effort and returns `inspectDigest`; `close` requires the `inspectDigest` echo, `acknowledge: { resultUnknown: true }`, `runbookRef` matching `^[A-Za-z0-9._:-]{1,64}$` (a values-free ticket handle) and the typed project; it closes `verified_result = 'unknown'`, `closed_mode = 'runbook'`, no settlement, the P5/P9 plan rule, and the BI link finished with the sheet-only `verifiedCreatedRows` (labels are on the sheet; no source needed), batch kept open.
- **After the close** the next computation re-plans from scratch; the planner holds duplicate keys (manual_confirm, duplicate_existing_key) and never writes around them.
- **Why `unknown` is safe:** nothing is replayed; the export needs a new settlement; plan-bound fields go to review fail-safe; the batch stays open and is never voided by the recovery.

### 3.9 Interleavings (the close decides under its locks; host writes are fenced by the lease; plugin-db ledger writes by a zombie are NOT — v1's "batch rows are touched only by lease holders" premise is withdrawn, RR G3)

| # | interleaving | what happens | why it is safe | evidence |
|---|---|---|---|---|
| 1 | Z frozen before its host write resumes after R's takeover | Z's `beforeWrite` CAS fails LEASE_LOST or its host write is refused by the fence; Z writes no row | I1, I5 | S9R-13 |
| 2 | Z frozen INSIDE its host write transaction at R's acquire | R waits the 5 s bound, 409 `holder_in_write`; after Z's transaction ends R retries, takes over, and its read sees Z's row (`landed`) | bounded row-lock wait | S9R-14 |
| 3 | Z's step-4 `finishExecution(aborted/failed)` commits between R's verify and R's close | R's close sees the new status (still unfinished), proceeds; `pre_close_status` = that status; if Z's finish invalidated CP (attempted > 0) the close applies P6-P9 instead of P1-P5. Z could not write after the takeover, so the classification stands | step 3/5 re-read under the locks | **S9R-25 (real-DB)**, RC-03 |
| 4 | Z's `finishExecution(succeeded)` commits first (Z finished every write and its final `reassert` before the takeover) | R's close: 409 NOT_UNFINISHED `execution_finished` | one winner on the execution row | S9R-22 (codes pinned) |
| 5 | R's close commits first; Z's step-4 finish runs later | Z's finish refuses STATE_MOVED `execution_not_running` (`CS:2832`); the ledger keeps R's verdict | CAS on `running` | S9R-22 (codes pinned) |
| 6 | Z's **self-verified** finish (0/0) races R's close | either Z commits first (R: 409 NOT_UNFINISHED `verified_closed`; consistent — nothing landed) or R first (Z's CAS fails) | one winner on the execution row | **S9R-28 (real-DB)** |
| 7 | a preview during the recovery | 409 WRITE_LOCKED at `assertNoLiveWriter` (`LK:972-976`) | live lease | S9R-21 |
| 8 | a continuation / change-plan / review decision during the recovery | 409 RECOVERY_PENDING under the state lock (`CS:1534`) or WRITE_LOCKED at `bumpGenerationWithin` | I2 | S9R-21 |
| 9 | a second `recover` | 409 WRITE_LOCKED while the first holds the lease; afterwards 409 NOT_UNFINISHED | lease, then the row status | S9R-21 |
| 10 | R's lease lapses during a long verification (> 240 s) and is taken over | step 2: another `lease_id` or epoch ⇒ 409 LEASE_LOST, full rollback | `holderWithin` | **S9R-26 (real-DB)**, RC-02 |
| 11 | Z's **BI `finish()`** runs before or after R's close | C-4: the link count is SET by value from the verified count and the BI finish is a CAS on the link being unfinished, so the final counts are exact in both orders (v1's `+=` at both finish and close double-counted on the normal E06 path, RR G3) | value semantics + CAS | **S9R-25**, S9R-BI-02 |
| 12 | Z's **BI `allocate()`** after R's takeover (Z frozen before its first create) | with C-6, Z's allocation transaction asserts the holder first and is refused LEASE_LOST; without C-6 it could void or supersede a live batch on a stale read (forwarded to BI, §4.5) | C-6 | **S9R-BI-04 (real-DB)** |
| 13 | a token minted before the recovery, and the `recovery_closed` bump fails | a pre-recovery token exists only in the narrow window of v1 §3.9 row 10. If the run landed rows, the revision compare refuses it (`existingRows` hash). If nothing landed, the in-lease recompute equals the token's revision only when the plan is still exactly current, so its apply writes exactly what a fresh preview would authorise (and binds CP only if CP is still `confirmed`). The bump is not load-bearing; the takeover's epoch + 1 moves the export bracket regardless | in-lease recompute | **S9R-27 (real-DB)** |
| 14 | the close vs a read-tier preview's reconcile | the reconcile takes the state row first and waits; after the close it fails its `decision_version` CAS ⇒ 409 STATE_MOVED, retried by the caller | step 9 | **S9R-29c (real-DB)** |
| 15 | the close vs R's own heartbeat | the heartbeat's CAS waits behind step 2's row lock for the commit's duration (milliseconds) and then succeeds with R's lease unchanged | heartbeat is a short CAS | **S9R-29d (real-DB)** |

### 3.10 The small-lane twins of E05-E09 (plan §9.2), each a real-DB case in the p4 host
| plan id | small-lane injection | must observe |
|---|---|---|
| E05 | every create lands; `finishExecution` is made to throw; the row stays `running` (route releases normally; a process death instead lets it lapse — S9R-12) | verify `landed`; close `verified_closed / landed`; continuations consumed; self-settles when the recompute is clean; the re-preview shows 0 ADD; zero `meta_records` / `meta_record_revisions` writes by the recovery. On a BI-installed sheet (S9R-BI-01): the linked batch closes, `created_row_count` = n, labels unchanged |
| E06 | the host refuses k of n creates (`select_option_not_found` fixture); finish `partial` | verify `mixed` (n-k landed, k not), the pending list names the k; batch kept open. Fix the fixture, preview (k ADD, same source digest), apply `succeeded`: on a BI-installed sheet all n rows carry the same 本次拉取 label, the batch closes once, `created_row_count` = n exactly (S9R-BI-02; the v1 double count 2n-k is the mutant) |
| E07 | the writer's records API hangs after j creates (the promise abandoned: a dead process); the lease lapses | takeover (epoch + 1); verify `mixed`; close completes; no permanent 409 |
| E08 | after E07's takeover the hung host call resumes | the host fence refuses it (0 rows); Z's finish is refused after R's close; the ledger keeps R's verdict; no old plan overwrites a newer machine value |
| E09 | the close's audit insert is made to fail | full rollback: the execution still unfinished; plan, RW, BI link and batch, continuations and settlement unchanged; still 失败待恢复 |

Large-lane E07 (a job stuck in stored `running`) stays a non-pilot repair (plan §9.2 E07 note; runbook B.2), outside G6.

### 3.11 Vocabularies and codes added by 6a
- **Lock (`LK:157-158`)**: purpose `recovery_verify`; reason `recovery_closed`. Pins: L11 and `readState`'s filter. Merge order: after BI-1, taking BI's entries as they are (RD G1 row 9).
- **Store**: `CLOSED_MODES = self_verified | puller_verified | runbook` (+ `legacy_runbook`, written only by migration 106's backfill, §7.2). `unprovable` is a report token, never stored.
- **Codes**: 404 `STOCK_PREP_REFRESH_EXECUTION_NOT_FOUND`; 409 `STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED` (`execution_finished`, `verified_closed`); 409 `STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE`; 409 `STOCK_PREP_REFRESH_RECOVERY_STALE`; 409 `STOCK_PREP_REFRESH_RECOVERY_RECOMPUTE_INCOMPLETE`; 409 `STOCK_PREP_REFRESH_RECOVERY_BUSY` (`step`); existing `STOCK_PREP_PROJECT_WRITE_LOCKED`, `STOCK_PREP_PROJECT_WRITE_LEASE_LOST`, `STOCK_PREP_REFRESH_STORE_FAILED`. Web `plainLanguage.ts` gains each code; `projectSync.ts` `awaiting_recovery` copy becomes 「上次写入未完成：请到「拉取待确认」核对并结束这次执行」; the scheduled pull's F-14 named outcome points there (existing subtest extended; `EXPECTED_OPS_TESTS_COUNT` unchanged).
- **Audit modes** (D9; no vocabulary migration): `exception_resolve` — `execution_verified_closed`, `execution_closed_unverified`, `execution_self_verified`; `project_board_read` — `execution_verify_read`, `execution_list_read`.

---

## 4. The batch identifier is BI's — the step-6 ↔ BI interface contract (RR G1/G3/G5, RD G1/G2)

### 4.1 Ownership
BI (<BI workflow>, register R-65) owns the two columns 首次批次 / 本次拉取, their ledger (migration 105), the writer stamping, the hash-neutral reader strip, the install/backfill tool, new-sheet birth, the R-line backport and their readiness checks. Step 6 owns recovery, the pilot read surfaces and the census/repair tooling. **One ledger, BI's.** Step 6's obligations toward it are exactly the clauses below. BI's design is pre-refutation, so each clause states what BI v1 already satisfies; whatever BI's reviser changes, the coordinator reconciles these clauses before S6-2 starts (open question OQ-1).

### 4.2 Contract clauses
| # | clause | who implements | BI v1 status |
|---|---|---|---|
| C-1 | **One ledger, no cross-imports.** Step 6 creates no batch table, band field, install route or label grammar. It reads and writes BI's ledger only through BI-store functions wired by the route as callbacks (`readBatchLink`, `batchWithin`, `listBatches`), so `CS` never requires BI, and BI's portable files never require a step-4 module (BI §10.2 scan rule holds). | both | consistent |
| C-2 | **Link discovery.** `readBatchLink({ tenantId, sheetId, projectNo, refreshExecutionId })` answers `{ linked, batchId, batchNo, label, status, linkFinished, linkCreatedRowCount, sourceDigest }` (values-free) from the link row whose `refresh_execution_id` equals the governed execution's id. At most one link per governed execution (one `small:<runId>` per small run); more than one ⇒ 409 STATE_MOVED `pull_batch_link_ambiguous` (defect). Requires every governed small-lane link to carry `refresh_execution_id`. | BI-1 (function), S6-2 (call) | satisfied (BI §2.3 l.169, §5.1 step 2); function to add |
| C-3 | **The recovery close hook** `batchWithin(trx, { scope, refreshExecutionId, result, verifiedCreatedRows, sourceDigest })`, run as step 6 of the close transaction (§3.6), locks the link, then its batch, FOR UPDATE (BI's own link → batch order) and: sets the link `finished_at = COALESCE(finished_at, now)` and its outcome token (`verified_landed / verified_mixed / verified_nothing_landed / verified_unknown`, in `writer_status` or a nullable column BI adds to 105 — BI's choice; inert on the R-line); sets the link count BY VALUE to `verifiedCreatedRows` and adjusts the batch count by the delta (C-4); for `landed`: an `open` linked batch → `closed / recovery_verified` (new BI closed-reason token); already `closed` by this link's own succeeded finish → no-op `already_closed`; `void`, or closed by another link → 409 STATE_MOVED `pull_batch_moved` (defect, rollback); for `landed` with NO link: an `open` batch whose `source_digest` equals `sourceDigest` (`'small:' + execution.source_content_digest`, §3.2) → `closed / completed_by_later_execution`, mirroring BI's finish rule for a succeeded run that allocated nothing (F6-22); for every other result: never closes, **never voids** (BI's label-scan rule decides at the next allocation). Returns the outcome token for the audit detail and the response. | BI-1 or S6-2 (function in BI's store module, importing nothing from step 4); S6-2 (call) | to add |
| C-4 | **Counts by value; one finisher per link.** BI's `finish()` updates a link only while `finished_at IS NULL` (first finisher wins; the recovery close is the alternative finisher). A batch's `created_row_count` equals the sum of its links' counts (maintained by delta or computed on read). Both orders of a zombie finish vs the close then give the exact count; v1's `+=` at both the finish and the close counted the E06 rows twice (2n-k, RR G3). | BI-1 | v1 increments; to change |
| C-5 | **The self-verified finish touches no BI row.** BI's own `finish()` (aborted / failed, its own count) records the link as usual. | S6-1 | consistent |
| C-6 | **Ledger mutations inside a leased lane assert the holder.** On main, `allocate()` — and recommended `finish()` and the install's ledger transaction — takes the lock row FOR UPDATE and asserts `lease_id` + `fencing_epoch` FIRST in its plugin-db transaction, through `LK.assertHolderWithin(trx, scopeKey, { leaseId, fencingEpoch })` with the exact contract of §3.6 step 2 (whichever of BI-1 and S6-2 lands first introduces it; the other reuses it). A refusal is a run stop (LEASE_LOST; nothing created). Void on the R-line (no lease; BI §10.2 turns void-reuse off). Reason: §4.5 F-BI-1. | BI-1 | missing (BI §2.4 allocates before the lease CAS) |
| C-7 | **Bands and digests.** BI band ids never join the template, the pack-aware band, the 6a intent band, PR-8 `writtenBand`, the compare/trigger band or the settlement/export machine digest; the formal export is unchanged. If the owner later puts the band into the formal export (O-BI-6), the band joins BOTH machine-digest producers (settlement and export gate C2) in that same PR, through the one `machineBandFieldIds` function — never one producer. The recovery never writes a band cell. | BI-1; S6-1/S6-2 assert | satisfied (BI §3.3, D-BI-13) |
| C-8 | **Hash neutrality reaches step-6 routes.** The recovery route's `computeDryRun` passes BI's `pullBatchBand` (BI §3.4 source-scan tripwire must list it). The MVP archive identity — `buildArchiveRevision`, the default `snapshotBatchId`, `syncRunId` — is byte-identical before and after install + backfill on an unchanged GOVERNED pilot sheet: case S9X-01 in the flip's G9 list (RD G2). | BI-1 (strip), S6-2 (pass), S6-9 (case) | satisfied for BI's own routes |
| C-9 | **Readiness covers all of U05's batch elements.** BI-1's `pull_batch_*` (v3) must prove: both columns present in `db` mode, both mapped (physical ids resolved), both carrying `humanWriteLock: 'plm_system'`, ledger readable, history resolved. If BI's checks omit the lock, S6-5 adds `pull_batch_columns_locked`. S6-5 adds the LIVE view check `pull_batch_columns_visible` (neither band id, physical or logical, in the current `prep-fill` / `prep-todo` hidden-field list; people with table-level write can edit shared views) unless BI-1 already ships an equivalent live check. | BI-1, S6-5 | lock: unclear in BI §6.2; live views: missing |
| C-10 | **A PULL-tier read of the ledger.** `listBatches({ scope, limit, cursor })` answers values-free rows (`batchNo`, `label`, `status`, `origin`, `openedAt`, `closedAt`, `createdRowCount`, `linkCount`). Step 6's PULL-tier route (§5.2) calls it and audits it; BI's admin status route and operate-tier board stanza are unchanged. | BI-1 (function), S6-4 (route) | function to add |
| C-11 | **Lazy allocation is accepted.** BI reads 「执行 ID 和批次关联在第一笔写入前持久保存」 as "before the first write that carries the label" (D-BI-3, BI §2.4). Step 6 accepts it: the batch labels creates only, and a governed run's logical-execution identity persisted before ANY write is the step-4 execution row plus the 6a-1 journal (§3.2). If R-65's veto window rejects the lazy reading, the recovery side needs no change. | — | consistent |
| C-12 | **Independence from 本次拉取's final rule.** Whether O-BI-2 keeps "the pull that created the row" or switches to "the last pull that wrote it", C-7 holds; under the second reading UPDATE / INACTIVE patches would carry 本次拉取 cells added after mapping, which the explicit intent and `writtenBand` lists still exclude (XI-02 re-run in that PR). | BI | n/a |

### 4.3 What each step-6 event does to the ledger (one table)
| event | link | batch |
|---|---|---|
| governed begin (6a-1) | none (BI allocates lazily in the writer) | none |
| self-verified finish (6a-1) | untouched by step 6; BI's own `finish()` records it (C-5) | untouched |
| recovery close `landed` | finished, outcome `verified_landed`, count := `verifiedCreatedRows` | linked: `open` → `closed / recovery_verified`; no link: same-digest `open` → `closed / completed_by_later_execution`; count by delta |
| recovery close `mixed` / `nothing_landed` | finished, outcome token, count := `verifiedCreatedRows` | kept open; count by delta; never voided |
| close-unverified `unknown` | finished, `verified_unknown`, count := the sheet-only count | kept open; never voided |
| zombie BI `finish()` after the close | CAS fails (`finished_at` set) → no-op (C-4) | untouched |
| zombie BI `allocate()` after the takeover | refused LEASE_LOST (C-6) | untouched |

### 4.4 Bands and hash neutrality, as step 6 uses them
- The settlement digest of a recovery close (§3.6 step 7) and the PR-5 export gate's C2 compare stay one function with one band; BI's cells are excluded from both (C-7). v1's inclusion (T6-5) is withdrawn — it would have moved every installed sheet's settled digest at install time and made the two producers diverge the day BI-1 merged (RD G1(c)).
- The recovery reads rows through BI's strip; the classifier's explicit field lists make it band-blind anyway (§3.2). The protective assertion is XI-02 (no fieldset ever holds a band id), and the positive real-DB evidence is S9R-BI-01 (creates carrying labels classify `landed`).
- E10 clause 3 (old archive ids, replay and revision rules unchanged) is BI's strip plus case S9X-01 on a governed sheet (C-8).

### 4.5 Findings forwarded to BI's reviser (through the coordinator; step 6 cannot edit BI's design)
- **F-BI-1 — zombie allocation (C-6).** BI §2.5 "Concurrency: … allocations of one sheet are serialized" assumes only the lease holder allocates. But `allocate()` commits in its own plugin-db transaction BEFORE the lease CAS (BI §2.4). Scenario on main: writer Z holds the lease and is frozen before its first create; the lease lapses; apply A2 takes over (epoch + 1), allocates batch N+1 (digest d2) and creates rows labelled N+1; Z wakes, `allocate()` finds the open batch N+1 with a digest ≠ Z's d1, and Z's stale in-lease read contains no row carrying N+1's label, so Z voids N+1 and reopens number N+1 for its own digest; Z's `fenceBeforeWrite` then fails. A2 keeps stamping a label whose batch is void, and two ledger rows share the number. Same falsified premise as RR G3 against v1. C-6 closes it.
- **F-BI-2 — finish double counting (C-4).** Increment-only counters double count whenever two finishers report the same rows (zombie finish + recovery close; RR G3's E06 path).
- **F-BI-3 — the recovery hook (C-3)** and its two vocabulary additions (`recovery_verified` closed reason; the four `verified_*` link outcomes).
- **F-BI-4 — a PULL-tier list function (C-10)** and **F-BI-5 — readiness coverage of the lock and of live views (C-9).**

---

## 5. 6c — read surfaces (PULL tier; plan §8, G8 「两个页面及关联展示已接通，读取有审计」)

### 5.1 The executions list (ships in S6-2; the recovery card needs execution handles)
`GET …/projects/:projectNo/refresh/executions?limit≤20&cursor`, `stock-prep:pull`. Items `{ id, status, verifiedResult, closedMode, preCloseStatus, startedAt, finishedAt, verifiedAt, plannedCounts, counts, written, attemptedWrites, abortCode, errorCodes, binding: { continuationCount, changePlanBound }, batch: { batchNo, label, status } | null, settlementSubject, recoverable }`. `batch` comes from C-2 (null when BI is not installed or the run created nothing). `recoverable` = unfinished and not `running` under the live lease. No principal ids (`startedBy` / `verifiedBy` stay in the audit trail; the 10-21 item-1 lesson). Audited `project_board_read`, mode `execution_list_read`, counts only. Store: `listExecutions({ scope, limit, cursor })` ordered `started_at DESC, id DESC`, equality WHERE.

### 5.2 The batches read (ships in S6-4; RD G1(h))
`GET …/projects/:projectNo/refresh/batches?limit≤50&cursor`, `stock-prep:pull`, over BI's `listBatches` (C-10). Answer `{ bandInstalled, batches: [{ batchNo, label, status, origin, openedAt, closedAt, createdRowCount, linkCount }] }` — values-free (labels hold an ordinal, a server date and a closed marker; BI §2.2). Audited `project_board_read`, mode `pull_batch_list_read`, counts only. BI's admin status route stays admin-only; the operate-tier board stanza is unchanged; the floor never sees this route (owner 2026-10-22: front-line neither sees nor acts on these surfaces).

### 5.3 The page — 「BOM 快照批次与差异」 (T6-15; RD G10)
- **Name and place.** The plan's page name, in the 工作 group, gate `STOCK_PREP_RAIL_GATE_PULL` (plan §8 「将两页放入「工作」组」; owner 2026-10-22, log line 57, opened 「BOM 快照批次与差异」 to the PULL tier). The existing rail key `bom-snapshot-diff` moves from the deploy group's `advanced` list (`WAT M:841-848`) to the end of the work group after `refresh-queue`, so the P1-08 keyboard order of the existing items is unchanged.
- **Two modes.** Default 「拉取批次与执行」 (new mode; plan 「新模式不读写旧 MVP 表」) with three sections: 批次 (§5.2, sorted by `batchNo`), 执行记录 (§5.1, with a 「核对」 deep link to the recovery card), 沿用关系 (S ↔ P through PR-5's values-free `refresh.continuations` and PR-4's audited continuation detail; rendered as 「S ← 被 P 沿用」 with the 沿用说明 facts). Sub-mode 「旧版快照存档」 = today's MVP-archive view, visible to platform admins only, backend unchanged (still `requireAccess 'admin'`) — plan 「旧模式保留为平台管理员子模式」.
- **Owner record.** The name, placement and default mode are written into the register (owner decision, O6-1) before S6-4 opens; this default is adopted unless the owner rules otherwise.

### 5.4 The recovery card (6a-3) in 「拉取待确认」
Shown when the board says `failed_pending_recovery`: the unfinished executions; 「核对上次写入」 (verify: the report and the paged pending list); 「结束这次执行」 (typed project number, enabled only when `closeAdmissible`); on UNPROVABLE the reasons plus 「请平台管理员按手册处理」; for an admin, 「按手册结束（结果未知）」 (close-unverified with its acknowledgement); on RECOVERY_BUSY 「正在处理中，请稍后重试」. After a close: 「请重新预览」. The floor sees only the board banner 「上次写入未完成，等待拉取人员核对；正式导出已暂停」 (counts, no controls; R-11 「可见即可用」). `plainLanguage.ts` gets every new code; the browser-verify fixtures get every new read (memory `stock-prep-nonrequired-browser-verify-check`).

### 5.5 Minimal for the pilot (owner may re-scope, O6-2)
Required (G4, G6): the executions list, `recover`, the recovery card. Recommended (G8, R-62 ③): the page with the batches read and the P↔S link. If the owner defers the page, G8 is carried until the first pilot pull by the sheet's BI columns, 沿用说明 in the formal export, the continuation detail inside 拉取待确认 and the executions list.

---

## 6. 6d — doubled-sheet census, remnant readiness, repair tooling (plan §6, §8 step A and step 6, §12.1 「两张历史表 | 修复核对、工具与预演并入第一期；实际写入逐表另批」)

### 6.1 Shapes (synthetic) and the condition v1 left implicit
- **D1 "two copies, both active"** (O-6): S's root subtree active AND an active nested copy under P. Readiness refuses it (`no_two_copy_component`); the pilot planner holds it `candidate_shape_unresolved` / `old_root_still_ordered`.
- **D2 "item-10"**: a pre-step-4 pull swept S's batch-1 rows inactive and ADDed the whole P subtree with S copies (log line 44); the human fills sit on the hidden inactive rows. O-6 does not see it (active rows only).
- **D3** duplicate keys; **D4** keyless active rows, counted in two columns — `keylessRowsWithoutCreator` (plugin-written; a defect) and `keylessRowsWithCreator` (hand-added; plan §10 「对无键人工行的处理另定」, now the owner's 10-27 manual-row rule, F6-30) — so owner-allowed manual rows never trip a 6d check; **D5** a non-boolean `active` cell (anything but boolean `false` is active, F6-17; F-11).
- **The head condition (RD G5).** On a governed pilot, D2 suspends every pull **only while S's own order line is still read** — call it **H1**: the dash rule drops S's order head, it expands under P, S has no active root, so `dropped_order_head_unresolved` holds (`customer_rule_pending`, no confirm; F6-17). If S's order line is no longer read (cancelled, or removed after P's release — the shape log line 48 anticipates) — **H0** — no dropped-head observation exists, nothing holds, and the pilot pull is clean: the copies SKIP or UPDATE and the inactive old rows SKIP `already_inactive` (F6-18). v1 §7.1 stated the H1 behaviour unconditionally; it holds only under H1.

### 6.2 Why no phase-1 sheet repair alone makes a D2/H1 project pilotable (v1 §7.2, unchanged)
Reviving the old S rows and retiring the copies fails (an inactive row still occupies its key: `AW P8:258`, `conflict-planner P8:1487`; the next pilot computation sees an active old root S and occupied new positions → `candidate_target_occupied`, A09, plan §12.2 (3)); deleting the copies breaks plan §1; re-keying is phase 2 (plan §6). For D2/H1 the only phase-1 path is to keep the copies as the live rows and record the customer's answer for S (6d-2b).

### 6.3 The item-10 sheet (T6-19)
- **After BI's backfill** (BI §7.4, owner's semantics, replacing v1 §7.3(c)): old S subtree 有效=否 首次=第1批（推定，d1） 本次=第1批（推定，d1）; S copies under P 有效=是 首次=第1批（推定，d1） 本次=第2批（推定，d2）; P and its new rows 有效=是 首次=第2批（推定，d2） 本次=第2批（推定，d2）. The fill view (有效 only) then separates batch-1 materials from new ones among the active copies — the customer's literal complaint — with no repair write. The doubling itself (fills on hidden rows) is untouched.
- **Pilotable only with:** (a) the customer's Q3 decision on the hidden fills, informed by the fills report's K2 classification (§6.6); and (b) EITHER an owner-recorded remnant acknowledgement `head_not_ordered` (H0, customer's Q1 answer: S is no longer separately ordered; S6-5) OR a scoped dropped-head ruling (H1, S6-7). A wrong acknowledgement fails closed: if a pilot pull then observes S's head, the project suspends with `dropped_order_head_unresolved` until a ruling or a pilot exit.
- **Recommended first-wave posture (unchanged):** not the first pilot; it keeps the pre-step-4 planner (C09); the 10-22 transition notice stays in force for S-then-P projects.

### 6.4 6d-1a — the census, everywhere it is needed (RD G3, G4)
- **Pure module** `lib/stock-preparation-sheet-census.cjs`: `censusOfRows(rows, { humanFieldIds })` → `{ rowCount, activeRowCount, twoCopyComponents, inactiveRootRemnantComponents (count + the per-component digests, the latter private), duplicateKeyGroups, keylessRowsWithoutCreator, keylessRowsWithCreator, nonBooleanActiveCells, inactiveRowsWithHumanCells, nestedCopiesWithHumanCells }`, using the pairing module's own `isActiveRow` / `isRootRow` and `EXISTING_ROW_CREATED_BY` (GOV-05). No step-4 state, no source read.
- **The R-line pack** `scripts/ops/stock-prep-sheet-census-<date>/` (`_preamble.sql`, `01-sheet-census.sql`, `README.md`), modelled on `scripts/ops/readonly-inventory-20260916/` (F6-28): SELECT-only; `\set ON_ERROR_STOP on`; `SET default_transaction_read_only = on`; a statement timeout. Per registry row (087; active and archived) it derives the staging project `tenant_id || ':integration-core'`, **self-checks** `'sheet_' || first 24 hex of sha1(project ':' object_id)` against the row's `sheet_id` (mismatch ⇒ that ordinal reports `status=incomplete reason=sheet_id_mismatch` and no counts — fail closed, e.g. a workspace-scoped deployment), derives the physical ids of `active`, `parentSourceId`, `componentSourceId`, `idempotencyKey` and the template human ids with `digest(…, 'sha1')` (pgcrypto, present since R74 migrations 041 / 042a; F6-27), and computes the same counts over `meta_records` (live rows only; `meta_records_trash` excluded) with the same predicates: `active` is inactive only when the JSON value is boolean `false`; root = blank `parentSourceId`; creator = `created_by IS NOT NULL`. The R-line has no 102-104 tables, so the pack reports no `governed` column. Output: one line per sheet keyed by a per-run **ordinal** (1..n), then `CENSUS_RESULT … status=complete|incomplete`. The ordinal → objectId map is printed only with `-v emit_private_map=1` and belongs in the private record. Stated limitation (README): `inactiveRowsWithHumanCells` / `nestedCopiesWithHumanCells` cover the template human columns only — pack `ext_` human columns need the pack ledger join, which the main-build route (§6.5) and the fills report (§6.6) cover.
- **CI evidence without a workflow edit.** Adding the pack to `ops-sql-pack-verify.yml`'s matrix is a workflow edit the zensgit token cannot push (F6-28). The pack's parity is instead a real-DB case in the p4 host (no workflow edit): S9D-02 builds synthetic project sheets through the real provisioning (staging project `T:integration-core`), seeds D1-D5 plus creator variants, runs the pack's SQL text on the same PostgreSQL, and requires per-sheet equality with `censusOfRows` over `readExistingStockPreparationRows`. A later push by an account with `workflow` scope may also list the pack in `ops-sql-pack-verify.yml` (optional).
- **Values-free public evidence (RD G4).** objectId handles are a non-secret digest of the project number (`PT M:11-13`) and can be brute-forced with a known tenant id; the repo is public. So #6079 and every PR body carry only aggregate counts or per-post ordinals; the ordinal ↔ handle map stays in the private record. The runbook's placeholder rule (`runbook-stock-prep-project-sheets-switch-on-20261014.md:6`) applies.
- **Authorization.** Running the pack on the customer host is an owner-authorized read of customer data (O6-3; plan §10 「客户机只读普查…按各自授权范围执行」). It needs no package: the operator runs `psql -f` with a read-only role during the transition step (plan §8 step A).

### 6.5 6d-1b — the census route, the remnant acknowledgement, the readiness check (RD G5)
- **Route** `GET /api/integration/stock-preparation/project-targets/census?cursor&limit≤10`, `stock-prep:admin`, project-sheets switch on, tenant from the verified principal. It pages over the tenant's registry rows and answers per row `{ ordinal, objectId, status, governed: 'pilot'|'protected'|'none'|'unreadable', …censusOfRows counts, acknowledgedComponents, rulingComponents }`. `objectId` is in the PRIVATE answer to an authenticated admin; the runbook forbids posting it (§6.4). Audited `project_board_read`, mode `sheet_census_read`, counts only. A single-project form `GET …/projects/:projectNo/target/census` lists the D2 components by component handle (`sha256(tenantId:projectNo:componentSourceId)` first 24 hex; private answer) for the acknowledgement.
- **Acknowledgement** `POST …/projects/:projectNo/target/remnant-acknowledgements`, `stock-prep:admin`, body `{ confirmProjectNo, componentHandle, basis: 'head_not_ordered', runbookRef, acknowledge: { customerAnswered: true } }`. It re-proves on a fresh project-scoped read that the component is currently a D2 remnant, then in one transaction inserts a row of `integration_stock_prep_component_ruling` (migration 107) with `kind = 'remnant_acknowledged'`, `status = 'active'`, and appends `exception_resolve` mode `remnant_acknowledged`. Revocation: `POST …/remnant-acknowledgements/:id/revoke` (status `revoked`, audited). Values-free: component digest, closed tokens, `runbookRef`, principal and clock — no business value, no free-text note.
- **Readiness** `no_unacknowledged_inactive_root_remnant` (v5): the project's D2 component digests minus those with an active `remnant_acknowledged` (or, once S6-7 exists, `dropped_head_included`) row must be empty. Positive evidence only; a store failure (for example 107 missing) is `ok: false`. It does not read the source; the first governed computation after enable is the authoritative observation of S's head, and it fails closed (§6.3).
- **Readiness** `pull_batch_columns_visible` (v5, C-9) unless BI-1 already ships an equivalent live view check.

### 6.6 6d-2a — repair tooling, UNCONDITIONAL in phase 1 (T6-18; RD G6, G7)
- **Recipes.** `retire_superseded_root_subtree` (turns D1 into D2) and `restore_retired_rows` (its inverse). Retire preconditions, re-proved inside the lease: the project is not governed; S's old root key is absent from the current expansion (fresh admin dry-run in the lease); exactly one active nested occurrence subtree pairs with the old subtree (`pairSubtrees` ok); no other repair run of the sheet is open. (v1's "a ruling for S exists" precondition is dropped: retirement is a data repair the customer's Q3 choice justifies; whether the result is pilotable is readiness's question, §6.5.)
- **The write.** `active: false` as a BOOLEAN (F-11; never `'false'`, `0` or `null`) on the old root subtree's active rows, with RUN stamps `lastPlmRefreshDecision: 'inactive'`, `lastPlmConflictSummary: '{"type":"sheet_repair_retire"}'`, `lastPlmRefreshRunId: <repair run id>`. Through a shared `runFencedPatches({ recordsApi, target, guard, patches })` (`lib/stock-preparation-sheet-maintenance.cjs`): `guard.beforeWrite()`, then `patchRecord({ …, writeFence: guard.hostWriteFence(), expectedVersion })`; a version conflict stops the run (never a blind retry) and the answer carries partial counts. Lease purpose `sheet_repair`, generation reason `sheet_repair` (post-release bump, best effort). Human cells are never in a patch.
- **Owner-bound one-shot execution (AGENTS.md 「owner-bound 一次性执行」).** Gates in order, zero IO before each: project-sheets switch → `MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED` exact `'true'` (default OFF; registered in `scripts/ops/global-history-flag-manifest.mjs`, `danger: 'medium'`) → `stock-prep:admin` → typed project → `approvalRef` (`^[A-Za-z0-9._:-]{1,64}$`, the register row or ticket that approved THIS preview digest) → in-lease recompute of the preview and the `planDigest` echo → **one-shot claim**: a row of `integration_stock_prep_sheet_repair_claim` (migration 108) with primary key `claim_key = sha256(tenant | sheet | project | recipe | planDigest)`, inserted in the same transaction as the run row; permanent, no TTL, no steal, fail-closed read-back on any insert failure (078 precedent, F6-26). A second run of the same approved plan ⇒ 409 `STOCK_PREP_SHEET_REPAIR_ALREADY_CONSUMED`; a different plan has a different digest and needs its own approval.
- **Backup before the first patch.** `integration_stock_prep_sheet_repair_run` (108): `id`, scope, `recipe`, `plan_digest`, `approval_ref`, `backup JSONB [[recordId, versionBefore, activeBefore]]`, `status` (`running | completed | stopped`), counts, by/at. Values-free.
- **Restore against CURRENT versions (RD G6).** A restore is its own recipe: a fresh preview over the backup's record ids, at their CURRENT versions, planning `active: true` only for rows still `active === false` that still carry this run's retire stamp; rows whose version moved since the retire are listed by cause (a human cell edited; revived by a pull because S's key re-entered the expansion; restamped). It gets its own `planDigest`, its own `approvalRef` and its own claim. Corrected evidence: a not-governed pull does NOT restamp a retired row whose key stays out of the expansion — the sweep SKIPs `already_inactive` without a patch (F6-18); versions move only through a person's edit or a revival. The runbook pauses the project's scheduled pull from retire until restore or ruling, and counts the sheet's automation rules and webhooks before the window (RD note: the plugin records path bypasses `RecordWriteService`'s emits, but the W0-1 operation ledger was not traced).
- **The fills report** (private, `stock-prep:admin`, audited `project_board_read` mode `sheet_fills_report_read`). Per D1/D2 component: the pairs (old row ↔ copy, by component and relative path), per human column whether each side is non-blank, and per pair the K2 class (F6-25): `k2_carryable` (only `HUMAN_PRESERVED_FIELD_IDS` cells whose target is blank or equal), `reenter_ext_human` (pack `ext_` human columns — K2 cannot carry them), `reenter_conflict` (a target cell non-blank and different — K2 refuses the whole row). The runbook presents K2 as a per-row tool for the first class only, never as the general path; Q3 is asked with these counts (RD G7).
- **Rehearsal.** CI (S9D-11, S9D-12) and a dev rehearsal (runbook B.6): census → fills report → retire (switch on, claim) → readiness → restore against moved versions → switch off.

### 6.7 6d-2b — the scoped dropped-head ruling (CONDITIONAL: the customer's Q1 for a named project, and the owner's decision to pilot it while its head is still read, H1)
- Rows of 107's table with `kind = 'dropped_head_included'`, keyed by component digest, `rules` ⊆ `BASE_DROP_RULES`, `position_fingerprint` (sha256 over S's sorted expansion keys at recording), `runbookRef`; values-free (v1's PRIVATE `component_source_id` and `basis_note` are dropped — the planner matches on the digest, so Q-B is not widened).
- Route `POST …/projects/:projectNo/target/dropped-head-rulings` (`stock-prep:admin`): a read-only expansion with the demand recorder proves the shape (base drop; expanded exactly at those positions; no active root; ≥ 1 active nested occurrence); then one transaction — the state row first if governed; INSERT; if a matching open `dropped_order_head_unresolved` hold exists, resolve it `runbook_closed`, `decision_version + 1`, `bumpGenerationWithin(…, { reason: 'dropped_head_ruling' })`; `appendWithin` `exception_resolve` / `dropped_head_ruling_recorded`.
- The planner gets a 12th continuation input key `droppedHeadRulings` (`CP P8:179-191`), read by the consult only when its first read says pilot (a database without 107 then affects pilot projects only). `detectDroppedHeads` skips component c iff an active ruling matches c's digest, c's CURRENT position fingerprint equals the ruling's, and every current observation's rule is in `rules`; otherwise the hold, with `detail.rulingMismatch: true`. Pilot detection only (C09); one project, one component, one structure; revocable.

---

## 7. Migrations, deploy order, rollback (numbers re-checked at publish with `git log --all --name-only -- 'packages/core-backend/migrations/*.sql'` and the open-PR file lists)

### 7.1 Numbering (T6-13)
| number | owner | content |
|---|---|---|
| 105 | **BI-1** (ships byte-identical to the R-line, so it must own the first free number) | BI's three ledger tables |
| 106 | S6-1 (6a-1) | execution columns (intent, source digest, close shape, `settlement_subject`), the intent table, `change_plan.recovered_from_change_plan_id`, the legacy backfill |
| 107 | S6-5 (6d-1b) | `integration_stock_prep_component_ruling` (both kinds; S6-7 adds no migration) |
| 108 | S6-6 (6d-2a) | `integration_stock_prep_sheet_repair_run`, `integration_stock_prep_sheet_repair_claim` |

`allowUnorderedMigrations: true` (BI F26) tolerates S6-1 merging before BI-1, but S6-1 still never takes 105.

### 7.2 106 — `106_extend_integration_stock_prep_refresh_execution_for_recovery.sql`
```sql
-- (header in the 077/087/100/103/104 style: purpose; values-free classification of every new column; deploy shape §7.4 —
--  deployed WITH the build, every project's consult 503s without it, the 104 posture; up-only, no down(), O-20 rollback with
--  RunMigrations 0; runtime role needs UPDATE on the execution and change-plan tables and INSERT/SELECT on the intent table,
--  the #6514 blind-spot class; the legacy backfill below)
ALTER TABLE integration_stock_prep_refresh_execution
  ADD COLUMN IF NOT EXISTS intent_version INTEGER,
  ADD COLUMN IF NOT EXISTS intent_digest TEXT,
  ADD COLUMN IF NOT EXISTS intent_entry_count INTEGER,
  ADD COLUMN IF NOT EXISTS source_content_digest TEXT,
  ADD COLUMN IF NOT EXISTS pre_close_status TEXT,
  ADD COLUMN IF NOT EXISTS closed_mode TEXT,
  ADD COLUMN IF NOT EXISTS verify_summary JSONB,
  ADD COLUMN IF NOT EXISTS verify_lease_run_id TEXT,
  ADD COLUMN IF NOT EXISTS verify_fencing_epoch INTEGER,
  ADD COLUMN IF NOT EXISTS runbook_ref TEXT,
  ADD COLUMN IF NOT EXISTS settlement_subject BOOLEAN NOT NULL DEFAULT true;

-- Step-4 F-16 allowed an owner-approved runbook DB operation to close a stuck execution before step 6. 102/103 are on no
-- customer host (step-4 §23.9), so such rows can exist only on dev / CI / test databases; they get an explicit legacy shape
-- so that every CHECK below VALIDATES (RR G10). A legacy row stays a settlement subject (settlement_subject = true).
UPDATE integration_stock_prep_refresh_execution
   SET closed_mode = 'legacy_runbook', pre_close_status = 'unrecorded', verified_result = COALESCE(verified_result, 'unknown')
 WHERE status = 'verified_closed' AND closed_mode IS NULL;

ALTER TABLE integration_stock_prep_refresh_execution
  DROP CONSTRAINT IF EXISTS integration_stock_prep_refresh_execution_intent_shape_check;
ALTER TABLE integration_stock_prep_refresh_execution
  ADD CONSTRAINT integration_stock_prep_refresh_execution_intent_shape_check
    CHECK ((intent_version IS NULL) = (intent_digest IS NULL) AND (intent_digest IS NULL) = (intent_entry_count IS NULL)
           AND (intent_entry_count IS NULL OR intent_entry_count >= 0)
           AND (intent_version IS NULL OR source_content_digest IS NOT NULL));
-- the same DROP IF EXISTS / ADD pair for each of:
--   pre_close_status_check     CHECK (pre_close_status IS NULL OR pre_close_status IN ('running','partial','failed','aborted','unrecorded'))
--   closed_mode_check          CHECK (closed_mode IS NULL OR closed_mode IN ('self_verified','puller_verified','runbook','legacy_runbook'))
--   close_shape_check          CHECK ((status = 'verified_closed') = (closed_mode IS NOT NULL)
--                                     AND (status = 'verified_closed') = (pre_close_status IS NOT NULL)
--                                     AND (status <> 'verified_closed' OR verified_result IS NOT NULL))
--   runbook_shape_check        CHECK (COALESCE(closed_mode, '') <> 'runbook' OR (runbook_ref IS NOT NULL AND verified_result = 'unknown'))
--   self_verified_shape_check  CHECK (COALESCE(closed_mode, '') <> 'self_verified' OR verified_result = 'nothing_landed')
--   settlement_subject_check   CHECK (settlement_subject OR (status = 'verified_closed' AND verified_result = 'nothing_landed'
--                                     AND (refresh_binding ->> 'changePlanId') IS NULL))

CREATE TABLE IF NOT EXISTS integration_stock_prep_refresh_execution_intent (
  execution_id      TEXT NOT NULL,
  chunk_index       INTEGER NOT NULL,
  tenant_id         TEXT NOT NULL,
  sheet_id          TEXT NOT NULL,
  project_no        TEXT NOT NULL,
  write_scope_key   TEXT NOT NULL,
  entry_count       INTEGER NOT NULL,
  entries           JSONB NOT NULL,
  fieldsets         JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, chunk_index),
  CONSTRAINT integration_stock_prep_refresh_execution_intent_chunk_check
    CHECK (chunk_index >= 0 AND entry_count BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_intent_scope
  ON integration_stock_prep_refresh_execution_intent (sheet_id, project_no);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_refresh_execution_subject
  ON integration_stock_prep_refresh_execution (sheet_id, project_no, started_at DESC) WHERE settlement_subject;
ALTER TABLE integration_stock_prep_change_plan ADD COLUMN IF NOT EXISTS recovered_from_change_plan_id TEXT;
```
Every `CREATE TABLE` body closes with `\n);` (the refresh-store kit's parser, `__tests__/support/stock-preparation-refresh-store-kit.cjs:93`). S6-1 extends the kit to model 106's ALTER-added columns (types `TEXT | INTEGER | JSONB | BOOLEAN`, the `NOT NULL DEFAULT true`, an exact count) and hand-models the `close_shape` and `settlement_subject` CHECKs the store relies on, so the hermetic store cases run against the real shape (KIT-01; RD G9).

### 7.3 107 and 108 (sketch; each follows §7.2's conventions)
- **107** `integration_stock_prep_component_ruling`: `id`, scope columns, `component_digest`, `kind` ∈ {`remnant_acknowledged`, `dropped_head_included`}, `basis` (`head_not_ordered` for the first kind, NULL for the second), `rules JSONB` and `position_fingerprint` (NULL for the first kind, NOT NULL for the second — a kind-shape CHECK), `status` ∈ {active, revoked} with a revoked-shape CHECK, `runbook_ref NOT NULL`, `recorded_by/at`, `revoked_by/at`; partial UNIQUE `(sheet_id, project_no, component_digest, kind) WHERE status = 'active'`. Values-free.
- **108** `integration_stock_prep_sheet_repair_run` (`recipe` ∈ {`retire_superseded_root_subtree`, `restore_retired_rows`}, `plan_digest`, `approval_ref`, `backup JSONB NOT NULL`, `status` ∈ {running, completed, stopped}, `(status = 'running') = (finished_at IS NULL)`, counts, by/at) and `integration_stock_prep_sheet_repair_claim` (`claim_key TEXT PRIMARY KEY`, scope, `recipe`, `plan_digest`, `run_id NOT NULL`, `approval_ref`, `claimed_by/at`). Values-free.

### 7.4 Deploy order and shape
1. **Main first** (owner 10-27): BI-1 → BI-2 on main. **R-line**: BI-4 is cut from **R75** (log line 135: once 090-096 ran on a machine, every later package there includes #6315) — R76 = R75 + BI-4, shipped under its own owner approval (gate ④). Step 6 never ships to the R-line; the census pack (S6-0) needs no package.
2. **Main-based customer package** (only once step 4 is pilot-ready, step-4 §23.9): carries 100-104, BI's 105 and step 6's 106-108. **Never** install a main-based package cut before BI-1's 105 merged onto a site that ran R76 (Kysely "missing migration"; BI §10.3).
3. **Shape without the step-6 migrations** (the runbook deploys them WITH the build; pre-flight checks 106 is recorded):
   - without 106: the consult's settlement-subject read fails 42703 ⇒ **every project's consult answers 503** — the 104 posture. v1's "safer than 104" claim is withdrawn: the subject read is a new column on an existing table every consult reads;
   - without 107: readiness `no_unacknowledged_inactive_root_remnant` is `ok: false` (no enable); once S6-7 exists, pilot projects' consults 503 (the ruling read is pilot-only);
   - without 108: the repair routes answer 503; nothing else reads it.

### 7.5 Rollback and U07 (plan §7 「回退不得丢失关系后恢复旧扫尾」; RD G8)
- Roll back with the old build and `RunMigrations 0` (O-20, unchanged).
- **What a pre-step-6 main build does with step-6 artifacts:** it ignores the new columns and the intent table; an unfinished execution still derives 失败待恢复; a CP left `confirmed` derives 已确认待执行; an RW is an ordinary `written` plan (变更待复核, export 409). But it derives a `verified_closed` newest execution as 已完成 (F6-9): only the export gate's C2 digest compare would then catch landed-but-unsettled writes, while the overview shows 可以导出. Hence a new stop condition.
- **Pre-rollback stop-condition queries** (values-free counts; the runbook B.7 text; S9R-U07 executes the same SQL): unfinished executions; **governed projects whose newest settlement subject is `verified_closed` and not named by `settled_execution_id`** (new — settle each with a clean preview before rolling back); `change_plan` rows in (`confirmed`, `written`), RW rows (`recovered_from_change_plan_id IS NOT NULL`) included; open holds; repair runs `running`; active rulings and acknowledgements (informational). An older build is forbidden while the blocking ones are non-zero; an R-line build is forbidden while any step-4 row exists (unchanged G10).
- **U07 evidence:** S9R-U07 (real-DB, in S6-2): each artifact class makes its stop-condition query non-zero. The G9 rollback drill (S6-9): on a dev deployment, a pre-step-6 build after `RunMigrations 0` against a database carrying an unfinished execution, a `verified_closed` RW-producing close, a CP left `confirmed` and a repair run: preview / apply / export refused where the queries say so; no ADD or INACTIVE written; values-free evidence.

---

## 8. Readiness additions and versions (U05, G3, G4; positive evidence only — a throw is `ok: false`)

| check id | PR | version | predicate |
|---|---|---|---|
| `pull_batch_columns_present`, `pull_batch_ledger_readable`, `pull_batch_history_resolved` | **BI-1** | **v3** | BI §6.2 (with C-9's coverage of mapping and lock) |
| `change_plan_store_readable` | S6-2 | v4 | `probeTableReadable('integration_stock_prep_change_plan')` (104; synthesis item 10) |
| `execution_recovery_ready` | S6-2 | v4 | `probeTableReadable('integration_stock_prep_refresh_execution_intent')` ∧ `PROJECT_WRITE_PURPOSES` ∋ `recovery_verify` ∧ the wired store exposes `readExecutionForRecovery` and `closeExecution` ∧ (band present ⇒ `readBatchLink` and `batchWithin` wired) — the plan's 「恢复入口」 |
| `no_unacknowledged_inactive_root_remnant` | S6-5 | v5 | §6.5 |
| `pull_batch_columns_visible` | S6-5 | v5 | live: neither band id in the current `prep-fill` / `prep-todo` hidden list (C-9; dropped if BI-1 ships an equivalent) |
| `pull_batch_columns_locked` | S6-5 | v5 | only if BI's checks do not already prove `humanWriteLock: 'plm_system'` on both band columns (C-9) |
| (the ruling exemption extends the remnant predicate) | S6-7 | v6 | §6.7 |

Each PR updates the header list (`RDY M:22-60`), `PILOT_READINESS_CHECK_IDS`, the suite and the web copy of the check ids; a PR landing out of this order takes the next version at merge. No enable happens before the flip, so an intermediate version never lands in a registry row. U05's six elements map as: 批次列 / 首次时间列 / 物理字段映射 / 机器列锁 → BI v3 (+ C-9); 视图 → `views_present` (existing) + `pull_batch_columns_visible`; 关系存储 → the step-4 store checks; 恢复入口 → `execution_recovery_ready`.

---

## 9. The marker-flip PR (S6-9) — exact preconditions (`CSUP:21` 0 → 1)

1. **Merged on main**, each with green CI and its own review on its own frozen head (E-5): PR-8 #6584 (round 2 included); PR-9 (change-plan and review pages; `review_pending` consumers); **BI-1 and BI-2** (R-65's veto window passed); S6-0, S6-1, S6-2, S6-3, S6-5, S6-6; the pre-pilot backend fix batch (synthesis item 8 (a)-(g)); the docs/G10 PR S6-8. S6-4 (the page) is required unless the owner re-scoped it (O6-2). S6-7 is not required (the first pilot is a clean project).
2. **Readiness ≥ v5** (≥ v6 if S6-7 merged) containing every check of §8. The readiness suite proves that with the marker set to 1 **in memory** a fully prepared synthetic sheet (BI band installed, history resolved, views live) answers `ready: true`, and that with the marker at 0 `continuation_support_version` is the only failing id.
3. **No dormant obligations.** `CS:2899-2903`'s 「step 6's verify-and-close to account for」 points to 6a-2; every step-6 residual named in a merged PR body is fixed or written into the register.
4. **The flip's own content** is limited to the literal, the tests pinned to 0, the register row and the PR body with the G9 matrix. No other code.
5. **G9 on the FROZEN candidate** (full CI dispatched on a tag; memory `ci-on-fixed-commit-via-tag-dispatch`):
   - U08: the synthetic end-to-end run A01 → A02 → A03 → A05 → C08 with E06 and E07 injected, on a BI-installed governed sheet: recovery, A03 「无新增物料批次」 (no BI ledger row), E10 labels kept across the retry;
   - **S9X-01** (C-8, RD G2): `buildArchiveRevision`, the default `snapshotBatchId` and `syncRunId` byte-identical before vs after BI install + backfill on an unchanged governed sheet;
   - **U07**: the rollback drill of §7.5;
   - U03: the authorization drill on every step-4/5/6 route and BI's routes across pull, operate, admin, a tenantless admin and cross-tenant callers;
   - the 14 S3A cases still hermetic-only, on real PostgreSQL (02, 03, 04, 05, 09, 10, 14, 15, 16, 20, 21, 24, 25, 26);
   - U09 in a real browser;
   - the plan §9 mutant list (step-4 §19, §11 here, BI §11.4);
   - the positive pilot-enable leg on a real deployment built from the frozen sha, with values-free evidence.
6. **Owner items gate ENABLE, not the flip:** Q-B; the pullers named (overturning 10-14 D3); the pilot project (not the item-10 project; not doubled; batch 1 pulled and the next not yet); BI's production windows (O-BI-1) for that sheet; the site facts (`specField`, the pack declaration, the step-④ flag); the R-63 ①, R-65 (BI) and R-91 (step 6) veto windows passed.
7. **Release line:** the flip ships only in a main-based package (step-4 §23.9), which includes BI's 105 by construction; §7.4 rule 2 applies on a site that ran R76.

---

## 10. Acceptance matrix per PR
Hermetic = plugin unit suites in `test-chain.txt`. Real-DB = cases in a new `describe('S9 step-6 …')` block of `packages/core-backend/tests/integration/stock-preparation-project-write-lock-realdb.cases.ts`, executed by `stock-preparation-p4-repair-once-realdb.test.ts` (no workflow edit). Every real-DB case asserts the plugin tables, `meta_records` and `meta_record_revisions`; interleavings use `pg_blocking_pids` handshakes, never sleeps (S8 lesson). Plan §9 「最低证据要求」: every concurrency, commit and takeover assertion below has a real-DB case; hermetic fakes are supplementary (RR G6).

### S6-0 (6d-1a) — census module + R-line pack
| id | layer | proves | plan |
|---|---|---|---|
| SC-01 | hermetic | `censusOfRows` on D1-D5 fixtures; keyless rows split by creator; string `'false'` counts active (D5) | §6, A09 |
| SC-02 | hermetic | values-free: a sentinel project number and objectId never appear in the pack's default output or in any public-format line; the private map appears only with `emit_private_map=1` | RD G4 |
| S9D-02 | real-DB | pack parity: the pack's SQL text on PostgreSQL gives per-sheet counts equal to `censusOfRows` over the reader for synthetic sheets built by the real provisioning | RD G3 |
| S9D-03 | real-DB | a registry row whose derived sheet id does not match reports `status=incomplete reason=sheet_id_mismatch` and no counts | fail-closed |

### S6-1 (6a-1) — intent journal, self-verifying finish, derivation
| id | layer | proves | plan |
|---|---|---|---|
| XI-01 | hermetic | one entry per ADD / UPDATE / INACTIVE / controlled update; none for SKIP / MANUAL_CONFIRM; fieldsets dedupe; chunks split at 2000 | §5.2 |
| XI-02 | hermetic | values-free (sentinel); digest stable; RUN ids and BI band ids (logical and physical) never in a fieldset | E-3, C-7 |
| XI-03 | hermetic | every row of the §3.5.1 table and the aggregation | E05, E06, E08 |
| XS-01 | hermetic (fake db) | begin writes execution + intent chunks in ONE transaction; a failing chunk insert leaves nothing and the apply refuses `partial: false` | 「第一笔写入前持久保存」 |
| XS-02 | hermetic | (a) unbound 0/0 failed/aborted → `verified_closed / nothing_landed / self_verified`, `settlement_subject = false`; (b) bound: CP stays `confirmed`, `settlement_subject = true`; (c) the 0/0 path never invalidates CP (P12) | W2, RR G2 |
| XS-03 | hermetic | NOT self-verified: attempted = 1; attempted null; `partial`; a throw without `writerPhase === 'pre_io'`; **a mid-run thrown error carrying `details.partial === false`** | RR G8 |
| XS-04 | hermetic | the writer sets `writerPhase === 'pre_io'` at exactly the three pre-loop refusals (F6-16) and nowhere else; `WRITER_PRE_IO_REASONS` pinned | RR G8 |
| XA-01 | hermetic | the intent is built from the in-lease recompute, never the token; `sourceContentDigest` = `RL.sourceContentDigestOf(dryRun)` | O-10 |
| XD-01 | hermetic | a `verified_closed / landed` subject behind ≥ 5 transparent closes still derives `executed_pending_settlement`; the `succeeded` variant too | U01, C12, RR G4 |
| XD-02 | hermetic | a plan-bound `nothing_landed` close is never transparent (P3, P8) | RR G2 |
| XD-03 | hermetic | a transparent close never writes settled columns; the previous subject's settlement still holds | RR G4 |
| XD-04 | hermetic | `normalizeConsult` rejects `settlementSubject === false` on any other shape (→ `unreadable`) | 把状态读取失败当零 |
| G-01 | hermetic (golden) | not-governed apply: no begin, no journal, byte-identical writer calls and response | C09 |
| KIT-01 | hermetic | the refresh-store kit models 106 (columns, default, hand-modelled CHECKs) | RD G9 |
| S9R-01 | real-DB | the PR-8 wedge W2 on an unbound run: decision-0 version-fence stop → `verified_closed / self_verified`; derived state not 失败待恢复; the next preview mints (non-pilot) or raises `content_change` for the moved cell (pilot) | PR-8 note 2 |
| S9R-01b | real-DB | W2 on a plan-bound controlled update: CP stays `confirmed`; derived 已确认待执行; export 409 before any preview; the next preview: `stale` → CP `invalidated(source_changed)` + `content_change` hold in one reconcile | RR G2 |
| S9R-02 | real-DB | the intent exists before the first write (host hook throws on the first create): rows present, digest matches, row `failed` with attempted 1; latency of a 10k-decision begin measured | §5.2 |
| S9R-03 | real-DB | begin atomicity on PostgreSQL: chunk k's insert fails → no execution row and no intent row remain; apply refuses `partial: false` | RR G6 |
| S9R-30 | real-DB | the subject window on PostgreSQL: one `verified_closed / landed` subject, then six transparent closes → the consult still contains the subject; `executed_pending_settlement`; export 409 | RR G4 |

### S6-2 (6a-2) — recovery verify-and-close
| id | layer | proves | plan |
|---|---|---|---|
| RV-01 | hermetic | order lease → read → recompute → classify → (close); zero record writes | §5.2, G6 |
| RV-02 | hermetic | each refusal with its code before any close: 404 (absent / other scope, same code), NOT_UNFINISHED, each UNPROVABLE reason, STALE, RECOMPUTE_INCOMPLETE | A11 |
| RV-03 | hermetic | public report values-free (sentinel); the pending page only in `verify`, audited before the response; refusing audit ⇒ no values | U03 |
| RV-04 | hermetic | the pending list pages (cursor, 200 per page, each page audited); `verifyDigest` covers the full classification | U04, RD G8 |
| RV-05 | hermetic | the close response reports the outcomes decided under the locks (plan, batch, `settled`, `preStatus`), not the verify report's (a fake moves them between verify and close) | RR survives (3) |
| RC-01 | hermetic (store) | the single-transaction lock order state → lock → execution → continuations → plans → BI link → BI batch (an order mirror; cross-transaction cycles are S9R-29's job) | TD-23 |
| RC-02 | hermetic | `holderWithin` mismatch → LEASE_LOST, full rollback | §3.6 step 2 |
| RC-03 | hermetic | status under the lock: `running → aborted` proceeds with `pre_close_status = aborted`; `succeeded` → `execution_finished` | §3.9 |
| RC-04a…j | hermetic | every §3.7 cell P1-P11, plus non-plan-bound continuations, settlement only when re-checked under the lock, `decision_version + 1` | B1 trace 3, RR G9 |
| RC-05 | hermetic | audit inside the transaction; an audit failure rolls everything back | E09 |
| RC-06 | hermetic | settlement only for a subject; a transparent close writes no settled columns | RR G4 |
| RC-07 | hermetic | 55P03 at step 2 → WRITE_LOCKED `holder_in_write`; at steps 3-10 → `RECOVERY_BUSY { step }` | RR G7 |
| BI-IF-01 | hermetic (fake BI store) | C-3: `landed` closes the linked open batch (`recovery_verified`), or a same-digest open batch when unlinked; other results keep it open; `void` / foreign close → 409 | RR G3 |
| BI-IF-02 | hermetic | C-4: the link count set by value, batch adjusted by delta; both finish/close orders give the exact count | RR G3 |
| BI-IF-03 | hermetic | the recovery never voids a batch, whatever the result | RD G1(a) |
| RR-01 | hermetic (routes) | tier matrix: pull ok; operate 403; tenantless admin 403; close-unverified 403 for pull, ok for admin; cross-tenant scope refusal with zero records IO; typed project; closed allow-lists; capability rows | U03 |
| L11 | hermetic | purpose `recovery_verify`, reason `recovery_closed`; `readState` keeps filtering; BI's entries kept | — |
| S9R-10…15 | real-DB | E05-E09 twins (§3.10); S9R-12 E07 with a lock-clock override; S9R-14 a zombie inside its host write | E05-E09 |
| S9R-16 | real-DB | C03 recovery leg: plan-bound `partial` run → RW(landed); review completes; remaining records re-held, CP2 confirmed and written, CP2 absorbs RW; keys, paths, parents, human cells unchanged | C03 |
| S9R-16b | real-DB | P6: finish invalidated CP, verify `landed` → RW of every write record | RR G9 |
| S9R-17 | real-DB | C08 chain: confirm → write fails → recover → review → export 200 → source change → review invalidated → export 409 | C08 |
| S9R-18 | real-DB | P1 / P2: a plan-bound run dies `running`; `landed` → CP `written`; `mixed` → CP invalidated + RW | B1 trace 3 |
| S9R-19 | real-DB | a duplicate under an intended key → UNPROVABLE; close-unverified → `unknown`; next preview holds the key | A09 |
| S9R-20 / 20b | real-DB | `diverged` → UNPROVABLE; admin close carries the diverged record into RW (P9; and P5 with CP still `confirmed`: CP invalidated first, then RW(all)) | C03, RR G9 |
| S9R-21 | real-DB | two concurrent `recover`s; a confirm during the recovery; a preview during the recovery | E01, E02 |
| S9R-22 | real-DB | Z's `succeeded` finish races the close, both orders, **codes pinned** (`execution_finished` / `execution_not_running`) | E08, RR G6 |
| S9R-23 | real-DB | **G2 cell P3**: confirm CP; crash after the begin, before the first host write; verify `nothing_landed`; close → CP still `confirmed`; derived 已确认待执行; **export 409 before any preview**; next preview `matches` → apply binds CP again → `written` | RR G2 |
| S9R-24 | real-DB | **G2 cell P8**: a bound run's first host write raises (attempted 1) → finish invalidates CP; verify `nothing_landed`; close → not transparent → 已执行待核对; export 409; the next computation opens `content_change` | RR G2 |
| S9R-25 | real-DB | §3.9 row 3: Z's `aborted` step-4 finish AND its BI `finish()` commit between R's verify and close → `pre_close_status = aborted`, exact BI counts (C-4), plan outcome per §3.7 | RR G3, G6 |
| S9R-26 | real-DB | §3.9 row 10: R's lease lapses mid-verification (lock clock) and is taken over → close LEASE_LOST, full rollback | RR G6 |
| S9R-27 | real-DB | §3.9 row 13: a pre-recovery token and a failed `recovery_closed` bump: `landed` → the token is refused; `nothing_landed` → its apply writes exactly the in-lease recompute; response `generationBumped: false` | RR G6 |
| S9R-28 | real-DB | §3.9 row 6: Z's self-verified finish races the close, both orders | RR G6 |
| S9R-29a, c, d | real-DB | pair interleavings (`pg_blocking_pids`): close vs a zombie non-settling finish (a); close vs a read-tier preview's reconcile (c: STATE_MOVED, retried); close vs R's own heartbeat (d) — b is S9R-28 | RR G6 |
| S9R-BI-01 | real-DB | E05 twin on a BI-installed governed sheet: creates carrying labels classify `landed`; the close closes the linked batch; count = n | C-3, C-7 |
| S9R-BI-02 | real-DB | E06 + retry on a BI sheet: same digest → the retry joins batch N; all n rows labelled N; one close; count = n exactly | E10, RR G3 |
| S9R-BI-03 | real-DB | the source gains a part between the failed attempt and the retry: `mixed` close; retry (different digest) → N closed `superseded_by_new_source`, landed rows keep N, the retry's rows get N+1 | RR G5 |
| S9R-BI-04 | real-DB | a writer frozen before its first create allocates after a takeover → refused LEASE_LOST by C-6; no ledger row from it | F-BI-1 |
| S9R-U07 | real-DB | each step-6 artifact class makes its §7.5 stop-condition query non-zero | U07, RD G8 |

### S6-3 (6a-3, web) — the recovery card
RC-W1 visibility by tier and state; RC-W2 verify render (paged) and close with a typed number; RC-W3 UNPROVABLE reasons and the admin flow; RC-W4 `plainLanguage` for every new code (RS-COPY live list); RC-W5 RECOVERY_BUSY / `generationBumped: false` copy. The scheduled-pull F-14 subtest is extended (no new subtest). New spec files get token registration.

### S6-4 (6c) — batches read and the page
ER-01 list and batches values-free (sentinel), no principal ids; ER-02 tier matrix (operate 403); ER-03 audit rows counts-only; PB-W1 three sections and ordinal sort; PB-W2 the P↔S link through the audited detail; PB-W3 the legacy sub-mode visible to platform admins only; PB-W4 rail placement (work group, after `refresh-queue`, P1-08 lane order of existing items unchanged). S9E-01 (real-DB): the routes answer the counts the stores hold.

### S6-5 (6d-1b) — census route, acknowledgement, readiness
SC-03 census route values-free and admin-only; SC-04 readiness remnant check with the acknowledgement exemption; SC-05 acknowledgement re-proves the shape, revocation audited; SC-06 the live view check. S9D-01 (real-DB): the item-10 fixture under **H1** — readiness refuses it, the census counts it, a governed pilot pull suspends `dropped_order_head_unresolved`. S9D-04: the same fixture under **H0** with an acknowledgement — readiness passes; the governed pilot pull is clean, settles, export 200. S9D-05: **H1 with a (wrong) acknowledgement** — the pilot pull suspends (fail closed).

### S6-6 (6d-2a) — repair tooling
RP-01 retire preconditions (governed → refused); RP-02 boolean `false` (F-11); RP-03 backup row before the first patch; RP-04 restore against CURRENT versions, moved rows listed by cause; RP-05 the one-shot claim (a second run of the same digest → 409 ALREADY_CONSUMED; fail-closed read-back on an insert failure); RP-06 gate order with zero IO before each refusal; MF-01 the flag-manifest entry (exact `'true'`, default OFF); FR-01 the fills report's K2 classes. S9D-11 (real-DB): D1 → retire → acknowledgement → clean governed pull. S9D-12: restore rehearsal with one row's version moved by a human edit (listed, skipped, its own approval). S9D-13: a concurrent human edit stops the retire; a re-run needs a NEW preview digest and claim.

### S6-7 (6d-2b, conditional) — the scoped ruling
DR-01 shape preconditions; DR-02 the planner skips the hold only on an exact match of digest, position fingerprint and rules; DR-03 a mismatch holds with `rulingMismatch`. S9D-10 (real-DB): D2/H1 + ruling → a clean governed pull, settled, export 200.

### S6-8 (docs/G10)
Runbook B.4 (recovery and close-unverified), B.5 (the census pack procedure, ordinals-only evidence), B.6 (repair window, automation count, paused pulls, restore), B.7 (§7.5 stop conditions and the U07 method); the delivery-guide updates of synthesis item 9; register rows R-91 and O6-1. Reviewed against the code it describes; no case ids.

### S6-9 (flip)
The readiness positive leg on a fully prepared synthetic sheet, and the G9 matrix on the frozen sha (§9.5).

---

## 11. Mutants (each must turn its named case red; in memory or a scratch copy, never on disk in the repo; restored byte-identical, sha256-checked)

| PR | mutant | case it must turn red |
|---|---|---|
| S6-1 | intent built from the token / preview | XA-01 |
| S6-1 | journal inserted after the begin's commit | XS-01, S9R-03 |
| S6-1 | self-verify ignores `attemptedWrites`; reads `null` as 0 | XS-03 |
| S6-1 | **self-verify keyed on `details.partial === false`** | XS-03 (RR G8) |
| S6-1 | `writerPhase` set on a mid-loop stop | XS-04 |
| S6-1 | intent band includes RUN fields | S9R-10 (date round-trip → `diverged`) |
| S6-1 | intent fieldsets admit a BI band id | XI-02 — the only case that can turn red: the decision record never carries band cells and the read strips them, so the mutant is equivalent at system level (RR G6's remap answered with this evidence) |
| S6-1 | **a provably-nothing-landed result invalidates a confirmed CP** | S9R-23, S9R-01b, XS-02b (RR G2) |
| S6-1 | **transparency applied to a plan-bound close** | S9R-24, XD-02 (RR G2) |
| S6-1 | **a transparent close writes the settled columns** | XD-03, RC-06 (RR G4) |
| S6-1 | **the consult without the settlement-subject read** | S9R-30, XD-01 (RR G4) |
| S6-1 | derivation keeps `verified_closed` as `complete` without a settlement; transparency extended to `landed` / `mixed` | XD-01 |
| S6-2 | verify without the lease, or without a takeover | S9R-13 |
| S6-2 | close admissibility read from the consult snapshot | RC-03 (the `running → aborted` leg), S9R-22 (codes pinned), S9R-25 |
| S6-2 | `holderWithin` removed | RC-02, S9R-26 |
| S6-2 | **55P03 after step 2 mapped to `holder_in_write`** | RC-07 (RR G7) |
| S6-2 | `landed` decided by key or record id only | XI-03, S9R-20 |
| S6-2 | the `duplicate` refusal dropped; `diverged` counted as `landed` | S9R-19; S9R-20 |
| S6-2 | no RW for a `mixed` plan-bound close | S9R-16, S9R-17 |
| S6-2 | a `landed` close does not stamp continuations | RC-04a |
| S6-2 | `verifyDigest` not required; close without a complete recompute | RV-02 |
| S6-2 | audit appended outside the transaction | RC-05, S9R-15 |
| S6-2 | recovery replays the stored plan (any record write) | RV-01 |
| S6-2 | close-unverified open to the pull tier | RR-01 |
| S6-2 | `decision_version` not advanced | RC-04, S9R-29c |
| S6-2 | **BI count incremented instead of set by value** | BI-IF-02, S9R-BI-02, S9R-25 (RR G3) |
| S6-2 | **a `landed` close leaves the linked batch open** | BI-IF-01, S9R-BI-01 (RR G3) |
| S6-2 | the recovery voids a batch | BI-IF-03 |
| S6-2 (BI mutant, step-6 case) | **BI `allocate()` without the holder assertion** | S9R-BI-04 (F-BI-1) |
| S6-2 | the pending list unpaged | RV-04 (U04) |
| S6-2 | the close response echoes the verify report | RV-05 |
| S6-2 | the recovery route omits `pullBatchBand` | BI's source-scan tripwire (BI §3.4) — equivalent for the recovery's own outputs (explicit field lists); stated |
| S6-4 | operate tier admitted; principal id in the list; legacy sub-mode shown to pull | ER-02; ER-01; PB-W3 |
| S6-0 | public output carries an objectId or project number | SC-02 (RD G4) |
| S6-0 | the pack treats string `'false'` as inactive | S9D-02 |
| S6-0 | keyless-with-creator rows counted as the D4 defect | SC-01 |
| S6-5 | the remnant check counts active roots only | SC-04, S9D-01 |
| S6-5 | the acknowledgement exemption ignored | S9D-04 |
| S6-5 | an acknowledgement recorded without re-proving the shape | SC-05 |
| S6-6 | the repair writes the string `'false'`; runs on a governed project; backup after the first patch | RP-02; RP-01; RP-03 |
| S6-6 | **restore with the backup's versions instead of current ones** | RP-04, S9D-12 (RD G6) |
| S6-6 | **no one-shot claim** | RP-05 (RD G6) |
| S6-6 | the write leg ignores the switch; a patch without `expectedVersion` | RP-06; S9D-13 |
| S6-7 | a ruling matched by component only | DR-02 |

The plan §9 list is carried by these, step-4 §19 and BI §11.4: 丢掉沿用保护 / 漏抑制新路径 / 忽略比较指纹 / 忽略旧计划代次 / 跳过项目互斥 — step 4, unchanged; 把状态读取失败当零 — XD-04, RV-02; 把 partial 当完成 — XS-03, XD-01; 重试覆盖首次批次 — BI M-BI-3, S9R-BI-02; 放过变更复核 — S9R-16, S9R-17, S9R-23, S9R-24; 复核不随新变化失效 — S9R-17; 大车道拒绝漏掉既有批准作业 — unchanged.

---

## 12. CI tripwires to budget
1. **Pins.** Recompute the `http-routes.cjs` / `index.cjs` LF digests (`lib/sealed-export/vectors/s6a-package-provenance-pins.json`) in every PR touching them — S6-1 (the generalised `auditWithin` lives in `HR`), S6-2, S6-4, S6-5, S6-6, S6-7 — AFTER merging main (BI-1 first); take main's other pins as they are.
2. **Test chain.** Every new suite joins `test-chain.txt` (bidirectional completeness test).
3. **Migrations.** Numbers re-checked at publish; the 077/087/100/103/104 header style; up-only; the runtime-role grants note; `\n);` endings; `DROP CONSTRAINT IF EXISTS` before every `ADD CONSTRAINT`; the refresh-store kit extended in S6-1 (KIT-01). No audit CHECK is re-listed (T6-12).
4. **Lock vocabulary pins (L11)**: S6-2 purpose `recovery_verify` + reason `recovery_closed`; S6-6 purpose `sheet_repair` + reason `sheet_repair`; S6-7 reason `dropped_head_ruling`. Each list grows in the PR of its first caller and merges after BI-1 (`pull_batch_install`), keeping BI's entries.
5. **Permission matrix**: the capability manifest (`WA:135`) ↔ route table ↔ web mirror (`WAT`) for every new route; the rail move of `bom-snapshot-diff` (S6-4) updates the manifest's gate.
6. **`CANONICAL_REPAIR_HAS_PRODUCTION_ENTRYPOINT`** stays `false`; the repair recipes never call the canonical repair.
7. **Readiness ids** pinned in the suite and in the web copy (§8).
8. **The continuation input key set** (`CP P8:179-191`) gains `droppedHeadRulings` in S6-7 only; the pairing closed-key tests and RL's "EXACTLY the 11-key" test move together.
9. **Real-DB cases** join the p4 host cases module (no workflow edit; the pushing token has no `workflow` scope, step-4 F42).
10. **`EXPECTED_OPS_TESTS_COUNT` unchanged.** The census pack has no `scripts/ops/__tests__` subtest; its parity is S9D-02 in the p4 host. Listing it in `ops-sql-pack-verify.yml` is optional and needs a workflow-scope push.
11. **`request(app)` banned** in core unit tests; the real-DB cases use `usePinnedServer()`.
12. **Web spec token registration** (`apps/web/scripts/run-required-web-tests.sh` + `.tokens`): keep main's lines and append.
13. **Browser-verify fixtures** for every new component read (non-required check; read it before merging).
14. **Flag manifest** covers `MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED` (S6-6; MF-01).
15. **`plainLanguage` coverage and the RS-COPY live list** cover every new code.
16. **PR-8 re-pins** (S6-1): the S8 suites asserting `invalidated(execution_failed)` for a zero-attempt bound stop move to `confirmed` + `verified_closed / self_verified`; the PR body lists each.
17. **BI's source-scan tripwire** must list the recovery route's `computeDryRun` call (S6-2).
18. **Windows-only local reds** are not this line's to fix; CI `test (20.x)` is the judge.
19. **S8 timing assumptions** apply to every S9R interleaving: `pg_blocking_pids` handshakes.

---

## 13. PR split, order, difficulty (memory `auto-dispatch-subagents-by-difficulty`: D4 Fable max, Opus max while Fable is 429 — say so in the body; D3 Opus xhigh; D2 Opus high; D1 Opus medium)

| # | PR (conventional title) | scope | tier | size | depends on | migration | acceptance |
|---|---|---|---|---|---|---|---|
| S6-0 | `feat(stock-prep): read-only doubled-sheet census — pure module and an R-line psql pack (batch-refresh step 6d-1a)` | §6.4 | D2 | S-M | none — can start now, in parallel with everything | none | SC-01, SC-02, S9D-02, S9D-03 |
| S6-1 | `feat(stock-prep): execution intent journal, self-verifying finish, settlement subject (batch-refresh step 6a-1)` | §3.2-3.4: 106; `CS` begin (one transaction) / finish (self-verify, CP kept `confirmed`) / consult (subject read); `lib/stock-preparation-execution-intent.cjs`; the apply lib builds the intent and the source digest; `AW` `writerPhase` marker; `RS` / `RL` subject; `HR` audit-hook generalisation; the kit; the PR-8 re-pins | **D4** | M | PR-8 #6584 merged (round 2 included; re-anchor F6-3/4/10); BI-1 merged first, or merge main after it and recompute pins | **106** | XI-01…03, XS-01…04, XA-01, XD-01…04, G-01, KIT-01, S9R-01, S9R-01b, S9R-02, S9R-03, S9R-30 |
| S6-2 | `feat(stock-prep): recovery verify-and-close under the recovery lease (batch-refresh step 6a-2)` | §3.5-3.11, §4: `LK` vocabulary and `assertHolderWithin` (if BI-1 did not); `CS` `readExecutionForRecovery` / `closeExecution` / `listExecutions`; `TA` `recoverStockPreparationExecution`; `HR` routes + capability rows; the BI callbacks (C-2/C-3 functions in BI's store module if BI-1 lacks them); readiness v4 | **D4** | L | S6-1; BI-1 (C-2, C-4, C-6 on main) | none | RV-01…05, RC-01…07, RC-04a…j, BI-IF-01…03, RR-01, L11, S9R-10…29, S9R-BI-01…04, S9R-U07 |
| S6-3 | `feat(web): recovery card in 拉取待确认 (batch-refresh step 6a-3)` | §5.4 | D2 | M | S6-2; PR-9 (shared `StockPreparationRefreshQueueView.vue`, `plainLanguage.ts`, `WAT`) | none | RC-W1…W5 |
| S6-4 | `feat(stock-prep+web): 「BOM 快照批次与差异」 PULL-tier mode — batches, executions, P↔S link (batch-refresh step 6c)` | §5.1-5.3: batches route over BI's `listBatches`; rail move; two modes | D2-D3 | M | S6-2; BI-1 (C-10); PR-9; owner record O6-1 | none | ER-01…03, PB-W1…W4, S9E-01 |
| S6-5 | `feat(stock-prep): census route, remnant acknowledgement and remnant readiness (batch-refresh step 6d-1b)` | §6.5, §8 v5 | D3 | M | S6-0; S6-2 (readiness order); BI-1 | **107** | SC-03…06, S9D-01, S9D-04, S9D-05 |
| S6-6 | `feat(stock-prep): doubled-sheet repair tooling — retire/restore recipes, backup, one-shot owner claim, fills report (batch-refresh step 6d-2a; real writes owner-gated per sheet)` | §6.6 | **D4** (production-write tool) | L | S6-0; merges after S6-2 (lock vocabulary order) | **108** | RP-01…06, MF-01, FR-01, S9D-11…13 |
| S6-7 | *(conditional)* `feat(stock-prep): scoped dropped-head ruling (batch-refresh step 6d-2b)` | §6.7, §8 v6 | **D4** | L | S6-5; the customer's Q1 for a named project; the owner's decision to pilot it under H1 | none (107's second kind) | DR-01…03, S9D-10 |
| S6-8 | `docs(stock-prep): step-6 runbook (recovery, census pack, repair window, rollback stop conditions), delivery guide, register R-91` | §10 S6-8 | D1-D2 | M | drafting now; final after S6-6 | — | review against the code |
| S6-9 | `feat(stock-prep): CONTINUATION_SUPPORT_VERSION 1 (batch-refresh pilot readiness)` | §9 | **D4** (verification) | S code | everything in §9.1 (BI-1, BI-2 included) | none | readiness positive leg; G9 incl. S9X-01 and the U07 drill |

**Order.** S6-0 now (independent; the transition step needs it). Then PR-8 merges → BI-1 → S6-1 → S6-2 → {S6-3 and S6-4 after PR-9 (S6-4 also after O6-1), S6-5} → S6-6 → S6-8 → (BI-2 merged) → S6-9. S6-7 only on a customer answer and an owner decision. Splitting 6a into S6-1 and S6-2 keeps the hot-path change apart from the new routes (the PR-3a/PR-3b lesson).

**Each PR body lists** the entry points and lanes it changes, its dependencies, its migration and rollback, the frozen verification sha, the acceptance ids with results, the mutants run, the model fallback note, and its blind spots. A body never marks an expectation as measured.

---

## 14. Open questions, owner items, customer items

### 14.1 Technical (T layer; the default is adopted unless the owner or a reviewer objects)
- **OQ-1 (coordinator).** BI is pre-refutation. Before S6-2 starts, the coordinator checks BI's FINAL design against C-1 … C-12 and the forwarded findings F-BI-1 … F-BI-5. Default: the clauses stand; **F-BI-1 (zombie allocation) is fixed in BI-1, not deferred** — it affects every project on main, not only pilots.
- **OQ-2.** Which PR introduces `LK.assertHolderWithin`? Default: whichever of BI-1 and S6-2 lands first, with §3.6 step 2's exact contract; the other reuses it.
- **OQ-3.** Where the recovery hook `batchWithin` (C-3) and `readBatchLink` (C-2) live. Default: in BI's store module (portable, importing nothing from step 4), written by BI-1 if its reviser accepts, otherwise added there by S6-2. Fallback if BI rejects the hook entirely: the recovery leaves every batch as it finds it (labels stay correct by BI's digest rule; only the ledger's status/count lag), and §4.3's table shrinks to "no-op".
- **OQ-4.** The puller close requires a COMPLETE in-lease recompute. Default yes; the admin close-unverified is the escape when the source cannot be read.
- **OQ-5.** RW is a new change-plan row (104 makes `invalidated` terminal). Default yes.
- **OQ-6.** Keep the `recovery_closed` bump. Default yes, best effort; S9R-27 shows it is not load-bearing.
- **OQ-7.** 2000-entry intent chunks for the 10k small-lane cap (five chunks). Default yes; S9R-02 measures the begin's latency.
- **OQ-8.** A stored `settlement_subject` flag with one extra read per scope (default) versus RR G4's alternative of three per-result reads (which would miss a plan-bound `nothing_landed` subject).
- **OQ-9.** One 5 s `lock_timeout` for the whole close with 55P03 classified by step (default) versus resetting the timeout after the lock row.
- **OQ-10.** The remnant exit: an owner-recorded acknowledgement (default) versus evaluating "is S's head still read" inside readiness, which would add a source read to readiness. Rejected because the first governed computation observes the head and fails closed (S9D-05), and readiness stays source-free (cost F-12).
- **OQ-11.** The census pack's CI evidence: the p4 parity case S9D-02 (default, no workflow edit) versus listing the pack in `ops-sql-pack-verify.yml` (needs a workflow-scope push; optional later).
- **OQ-12.** One page with two modes (default) versus two rail items.
- **OQ-13.** PR-8 round 2 re-anchor. If round 2 changes the bound-plan begin/finish (F6-3/F6-4), the reconcile's deferral (F6-10) or 104's CHECKs (F6-12), S6-1 re-derives T6-4 and the §3.7 table on the merged code before implementing, and records the delta in its body.
- **OQ-14.** 106's legacy backfill (default; the rows exist only on dev/CI; validated CHECKs) versus `NOT VALID` constraints (RR G10 offered both and deferred to the deploy lens).

### 14.2 Owner items (O layer; nothing here starts without them)
- **O6-1.** Record the page decision (T6-15: 「BOM 快照批次与差异」, PULL tier, 工作 group, new mode by default, legacy archive as a platform-admin sub-mode) in the register before S6-4 opens.
- **O6-2.** Re-scope 6c if wanted: the page before the first pilot, or after it (§5.5).
- **O6-3.** Authorize running the census pack on the customer host (a read of customer data; plan §10). Evidence posted: counts and per-post ordinals only; the ordinal ↔ handle map stays in the private record.
- **O6-4.** Whether to pilot a doubled project (the item-10 project). If yes: Q3 first; then an acknowledgement (H0) or S6-7 and a ruling (H1); BI's backfill for that sheet.
- **O6-5.** Remnant acknowledgements: recorded by `stock-prep:admin` only on the customer's Q1 answer relayed by the owner, with a `runbookRef`.
- **O6-6.** Repair windows per sheet (gate ② 写客户生产主表): the switch on and off, one `approvalRef` per approved preview digest, the project's scheduled pull paused from retire until restore or ruling.
- **O6-7.** Who may run close-unverified on site (default `stock-prep:admin`; alternative platform admin only) and the runbook's approval step (ticket format).
- **O6-8.** BI's owner items that step 6's acceptance touches: O-BI-1 (BI's production windows), O-BI-2 (本次拉取's meaning; C-12), O-BI-6 (the band in the formal export; C-7's both-producers rule).
- **O6-9.** Q-B is **not widened** by step 6 (T6-20): the journal, closes, census, acknowledgements and rulings are values-free; private values appear only in the audited verify pending page and the admin fills report, which read the sheet and persist nothing.
- **O6-10.** R-91 (the T6 decisions): the 24 h veto window.

### 14.3 Customer items (through the owner; the dev machine never contacts the customer)
- **CI-1 (Q1, per doubled project).** S was ordered first, then appears inside P: the same demand prepared earlier? Is S still ordered separately today (decides H0 / H1)?
- **CI-2 (Q3, per doubled project), asked with the fills report's counts.** Which copy do people fill now? Were the old rows filled, were rows deleted? Per pair the report says which fills K2 can carry and which must be re-entered (`ext_` human columns; targets already filled with a different value). With BI's backfill the active copies read 首次=第1批（推定） 本次=第2批（推定）: is that legible?
- **CI-3 (Q4).** The 沿用说明 wording (unchanged from step 4; asked at pilot preparation).
- BI's own customer questions (label format, material-level 首次批次) are BI's.

---

## 15. Residual risks (ranked)
1. **Host automations or API writes to machine columns** are detected, not prevented (C2 at export, `diverged` at recovery); readiness recommends none on a pilot sheet (step-4 §22 risk 1).
2. **A canonicalisation gap** between plan-time and read-back values for some field type would make a landed write `diverged` (unprovable → admin close). RUN fields are excluded; PR-8's review digests prove the content band; S9R-10 asserts `landed` for every field type of the template band and of the customer-pack fixture.
3. **106 must deploy with the build**: without it every project's consult answers 503 (the 104 posture; §7.4). The runbook pre-flight checks it.
4. **BI is pre-refutation.** If BI's final design rejects C-3 / C-4 / C-6, the recovery's ledger bookkeeping degrades to "leave as found" (OQ-3), and F-BI-1 stays a BI risk for every project on main.
5. **Batch reuse across a long gap** is BI's documented semantics: a same-source-digest pull joins the open batch. A changed source can never inherit a label (S9R-BI-03); the recovery never mints, reuses or voids.
6. **A wrong remnant acknowledgement** suspends that pilot project (fail closed) until a ruling or a pilot exit; pilot exit keeps protection (C10).
7. **Rollback to a pre-step-6 build** derives `verified_closed` as 已完成; mitigated by §7.5's new stop condition and by C2.
8. **The begin transaction grows** by up to five intent inserts for a 10k-decision pull; S9R-02 measures it; a timeout only refuses the run.
9. **The census pack's staging-project convention** (`${tenantId}:integration-core`) is self-checked per row; a different convention reports `incomplete` (no wrong counts) and needs the main-build route.
10. **close-unverified misuse** as an un-wedge: it needs the inspect digest, an acknowledgement, a ticket reference and the admin tier, and it is audited.
11. **The registry stamp `last_pull_outcome` stays `failed`** after a recovery close until the next apply stamps it — cosmetic; the derived state gates every formal surface.
12. **Merge friction:** S6-1 / S6-2 / S6-5 / S6-6 against BI-1 (apply-writer, table-actions, http-routes, index, lock vocabularies, readiness); S6-3 / S6-4 against PR-9 (web files). Sequence per §13 and recompute pins after merging main.

---

## 16. Refutation gaps and their disposition
"Closed" = the design now does what the gap required (or an equivalent the gap allowed), with the cases named. "Answered" = the gap's premise is addressed with code evidence instead. "Forwarded" = it is BI's to implement; step 6 states the clause and the case that checks it.

| gap | severity | disposition | where | evidence / cases |
|---|---|---|---|---|
| **RR G1** — 6b-1 superseded; one ledger; carry-over requirements (1)-(6); what 6a does to the ledger | blocker | **Closed.** 6b removed; BI is the one ledger; (1) persisted link per lane = BI D-BI-3 (small governed / non-governed via `small:<runId>`, large via `large:<jobId>` across chunks, retries, takeover), with the lazy reading accepted (C-11) because the governed run's identity before ANY write is the execution row + journal; (2) no 103 dependency — BI 105; (3) E10 — BI §3.5; (4) A03 — BI's lazy allocation, 本次拉取's rule stated separately (C-12); (5) apart from `snapshotBatchId` — BI §2.1 + S9X-01; (6) out of decisions, intent band, `writtenBand`, compare/trigger — C-7, XI-02; the close and self-verified finish's effects — §4.3 | §0, §4 | XI-02, S9R-BI-01…04, S9X-01 |
| **RR G2** — a plan-bound `nothing_landed` close destroys the confirmation | high | **Closed.** The preferred fix (CP stays `confirmed`) for P3/P4, plus the backstop for the cell the preferred fix cannot reach (CP already `invalidated(execution_failed)`, terminal per 104): plan-bound closes are never transparent (P8) | §3.3, §3.4, §3.7 | S9R-23, S9R-24, S9R-01b, XS-02b, XD-02; mutants "invalidates a confirmed CP", "transparency on a plan-bound close" |
| **RR G3** — "touched only by lease holders" false; double count; `landed` close does not mirror success | medium | **Closed.** Premise withdrawn (§3.2, §3.9 rows 3, 11, 12); counts by value + one finisher per link (C-4); `landed` closes the linked batch or a same-digest open batch, mirroring BI's succeeded finish, using the new `source_content_digest` (C-3, §3.2); batch status asserted under the lock (C-3) | §3.6, §4 | S9R-25, S9R-BI-01/02, BI-IF-01/02; the E06 count = n |
| **RR G4** — the subject window cannot protect a `verified_closed` subject; XD-01 weak; transparent close self-settles | medium | **Closed.** Stored `settlement_subject` + one subject read per scope (T6-6); XD-01 rebuilt on a `verified_closed / landed` subject behind ≥ 5 transparent closes plus the `succeeded` variant; a transparent close never settles | §3.4, §3.6 step 7 | XD-01, XD-03, RC-06, S9R-30 |
| **RR G5** — batch identity under retry/takeover unbound | medium | **Answered via BI, then forwarded.** BI binds the open batch to the opening source digest (D-BI-4): only a same-digest pull joins, a different digest closes it `superseded_by_new_source`; residual risk 4 of v1 is replaced by §15 risk 5 | §4.2, §15 | S9R-BI-03 (source gains a part between the failed attempt and the retry) |
| **RR G6** — concurrency evidence hermetic or mis-mapped | medium | **Closed.** Real-DB S9R-25 (row 3), S9R-26 (lease lapse), S9R-27 (token + failed bump), S9R-28 (zombie self-verify), S9R-03 (begin atomicity), S9R-23/24 (G2), S9R-29a/c/d (pair interleavings); RC-01's claim narrowed to a single-transaction mirror; mutant map corrected — the snapshot mutant is killed by RC-03 and by S9R-22 with codes pinned; the band mutant is shown equivalent at system level and mapped to XI-02 | §3.9, §10, §11 | as listed |
| **RR G7** — `SET LOCAL lock_timeout` scope; 55P03 mapping | low | **Closed.** 55P03 classified by step; `RECOVERY_BUSY { step }` after step 2 | §3.6 | RC-07 |
| **RR G8** — self-verify keyed on overloaded `partial:false` | low | **Closed.** Writer-scoped `writerPhase === 'pre_io'` at the three pre-loop refusals only | §3.3 | XS-03 (mid-run `partial:false` mutant), XS-04 |
| **RR G9** — §3.7 cells under-specified; batch status unasserted | low | **Closed.** P1-P12 with test ids, no overlapping rows, `confirmed + unknown` = invalidate first then RW(all); batch status asserted (C-3) | §3.7 | RC-04a…j, S9R-20b |
| **RR G10** — 105's CHECKs vs pre-step-6 runbook closes | low | **Closed.** 106 backfills legacy rows to `legacy_runbook` / `unrecorded` before validated CHECKs (the rows exist only on dev/CI) and uses `DROP CONSTRAINT IF EXISTS`; `NOT VALID` considered (OQ-14) | §7.2 | KIT-01; migration review |
| **RD G1** — owner overturned 6b; eight collisions + merge order with BI | blocker | **Closed.** Removal list (§0); (a) C-3; (b) the report's `batch`, RC-04 and the S9R-BI cases reference BI rows; (c) C-7 exclusion adopted; (d) readiness BI v3 → S6-2 v4 → S6-5 v5 → S6-7 v6, plus C-9's live view and lock checks; (e) BI owns 105, step 6 takes 106-108; (f) deploy order §7.4 (R-line cut from R75; never a pre-105 main package on a site that ran R76); (g) §9 names BI-1/BI-2 and the release line; (h) §5.2's audited PULL-tier read; (i) §6.3 rewritten to BI §7.4 semantics, CI-2 rewritten; (j) §13 orders step-6 PRs after BI-1 with pin recompute | §0, §4-§9, §13 | S9R-BI-*, ER-*, §8 |
| **RD G2** — install + backfill re-mint the archive's batch id | major | **Closed by inheritance.** BI's strip (D-BI-6) + C-8 + the governed-sheet case S9X-01 in the flip's G9; the "drop the strip" mutant is BI M-BI-2, also mapped to S9X-01 | §4.4, §9 | S9X-01 |
| **RD G3** — the census cannot run on R74 in the transition | medium | **Closed.** S6-0's read-only psql pack runs on R74/R75 with no package (pgcrypto present; physical ids derivable; self-checked); parity pinned by S9D-02 without a workflow edit. The `headObserved` dimension is deliberately not added (OQ-10) | §6.4 | S9D-02, S9D-03 |
| **RD G4** — per-handle census evidence is not values-free | medium | **Closed.** Public evidence = counts or per-post ordinals; the ordinal ↔ handle map stays private | §6.4, T6-16 | SC-02 |
| **RD G5** — remnant readiness can refuse forever | medium | **Closed.** The H0/H1 condition is stated; an owner-recorded, values-free, per-component acknowledgement exempts a remnant without a base-drop proof; a wrong acknowledgement fails closed at the first governed computation | §6.1, §6.3, §6.5 | SC-04, S9D-01, S9D-04, S9D-05 |
| **RD G6** — 6d-2 schedule, gate binding, restore semantics | medium | **Closed.** 6d-2a unconditional (S6-6); a DB-enforced one-shot claim on (sheet, project, recipe, planDigest) + switch + `approvalRef` + digest echo; restore against current versions with its own approval and claim; pulls paused. Evidence corrected: the sweep SKIPs already-inactive rows without restamping (F6-18), so versions move only by a person's edit or a revival | §6.6 | RP-04, RP-05, S9D-12, S9D-13 |
| **RD G7** — K2 is not a general path for the item-10 fills | medium | **Closed.** The fills report classifies each pair (`k2_carryable` / `reenter_ext_human` / `reenter_conflict`); the runbook limits K2 to the first class; Q3 is asked with the counts | §6.6, CI-2 | FR-01 |
| **RD G8** — U07 missing; U04 not met for recovery | medium | **Closed.** U07 = S9R-U07 + the G9 rollback drill + a new stop-condition query; the pending list is paged | §3.5, §7.5, §9 | S9R-U07, RV-04 |
| **RD G9** — migration text vs the kit and the convention | minor | **Closed.** `\n);` endings, `DROP CONSTRAINT IF EXISTS`, the kit extended in S6-1 | §7.2 | KIT-01 |
| **RD G10** — 6c naming against the owner's 10-22 decision | minor | **Closed.** Default = the plan's page name at the PULL tier in 工作, legacy archive as a platform-admin sub-mode; recorded as an owner decision before S6-4 | §5.3, O6-1 | PB-W3, PB-W4 |

---

## 17. What survives (verified by the refuters or the reviser; do not re-litigate)
- **Lock order has no cycle** (RR): every transaction that takes both the state row and the lock row takes the state row first; the transactions that skip the state row (non-settling or zombie finish, non-plan-bound begin, heartbeat, host-fence FOR SHARE, takeover UPDATE) never wait in a cycle with the close; a new begin cannot overlap a zombie finish (`RL:453-466`, `RL:536-547`). The BI rows join the close's order after the plans and in BI's own link → batch order; C-6 puts the lock row first in `allocate()` (§3.6, §4.2).
- **Takeover plus the host fence fence out a dead or lapsed writer's host writes**, including clock skew (RR) — for host records only; plugin-db ledger writes need C-6.
- **The close re-decides every admissibility fact under its locks**; the classification is fenced by the lease against plugin host writers (RR).
- **The 0/0 self-verify rule is sound for today's writer** (RR); only its best-effort trigger changed (RR G8).
- **`landed` / `mixed` / `unknown` plan handling never lets a landed field escape review**, given PR-8's N3 `expectedContent` (RR); `nothing_landed` is fixed by T6-4/T6-5.
- **The 422 analysis** (RD): no new column ever joins the frozen template; BI agrees (BI §3.2).
- **Registry reads are `SELECT *`** (`PTS M:195/:229/:355`); **`isActiveRow` is strict** (F-11 load-bearing); **the fill / to-fill views hide by an explicit list**; **managed fields cannot be deleted by people**; **R74 has `human-write-lock.ts`**; **`readState` maps unknown lock tokens to null on rollback**; **`test-chain.txt` is not pinned** (only the `http-routes` / `index` LF digests); **the A-08 archive test is unaffected**; **the sealed-export runtime persists only the nine MVP objects**; **package verify does not enumerate 10x migrations** (RD).

---

## 18. Coverage self-check (plan and design ids → where this design answers them)
| id | where |
|---|---|
| F-16 (no code sets `verified_closed`) | §3.3, §3.5-§3.6, §3.8 |
| D-22 / G6 (step 6 before enable) | §9 |
| step-4 §9.3 (失败待恢复 → 完成 only via recovery) | §3.4, §3.6, §3.9 |
| step-4 §17 step-6 row (`recovery_verify`, `recovery_closed`, E05-E08 twins, batch columns) | §3.5, §3.11, §3.10; batch columns → BI via §4 |
| PR-8 version-fence wedge (W2) | §3.1, §3.3, S9R-01 / 01b |
| plan-bound landed fields (B1 trace 3) and the `nothing_landed` hole (RR G2) | §3.7, S9R-16…18, S9R-23/24 |
| admissibility under the state-row lock | §3.6, §3.9 |
| A03 / E10 / U06 / G3 (batch columns, backfill) | BI (§4.2 C-7/C-8/C-11/C-12), S9R-BI-02, S9X-01, U08 in G9 |
| E05 / E06 / E07 / E08 / E09 | §3.10, S9R-10…15, S9R-BI-01/02 |
| U04 (paged evidence) | §3.5, RV-04 |
| U05 | §8 (BI v3 + C-9 + `execution_recovery_ready`) |
| U07 | §7.5, S9R-U07, G9 drill |
| C03 / C08 recovery legs | §3.7, S9R-16, S9R-17 |
| G4 (恢复入口) / G8 (two pages, audited reads) / G10 (runbook) | §3.5, §5 / §5.2-§5.3 / S6-8 |
| plan §5.2 「首次拉取归属」 apart from `snapshotBatchId` | BI §2.1, C-8, S9X-01 |
| 422 `TARGET_SCHEMA_INCOMPLETE` on deploy | §0 (BI §3.2) |
| plan §8 step A (census in the transition) | §6.4 (S6-0) |
| plan §12.1 两张历史表 (tools and rehearsal in phase 1, writes per table) | §6.6 (S6-6), O6-6 |
| F-11 (boolean `false`) | §6.6, RP-02 |
| O-6 / O-7 and the item-10 shape | §6.1-§6.3, §6.5, S9D-01/04/05 |
| owner 10-27 batch identifier (log line 127) | §0, §4 |
| owner 10-27 manual rows (log line 133) | §6.1 (D4 split), §3.5.1 |
| R-line base R75 (log line 135) | §7.4 |
| PR-8 round 2 (log line 136) | baselines, OQ-13 |
| marker-flip preconditions | §9 |

— end of design-final.md —
