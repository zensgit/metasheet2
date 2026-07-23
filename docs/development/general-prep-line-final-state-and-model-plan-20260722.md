# 通用备料线 — 收口状态、余下开发与模型规划（设计+验证）

**日期**：2026-07-22　**分支**：`claude/prep-p1a-substrate-proof-20260722`（head `86f183369`，未 push 前置独立审）
**定位**：把参考系统（Java Spring Boot `stockorder` + Vue，直连 DN-PDM/K3 SQL Server + 钉钉/宜搭）自建备料系统，做成 **MetaSheet 多维表上一个受治理的备料 scenario**——不是备料 App，是底座上的一条治理线。

> 本文是这条线的**定版收口**：`§2` 已建成 + 验证矩阵；`§3` 余下开发盘点（目标可否设 + 门 + 模型 + 排序）；`§4` 验证纪律与审阅轨迹；`§5` 诚实边界。设计/可行性细节见同目录 `general-prep-system-feasibility / development-plan / execution-plan / system-design-and-verification`。

---

## 1. 一句话结论（精确当前状态）

**实现基本完成、全部 unarmed**：地基实证（P1a）、四个 pure 能力模块（P1b/P4/P3）、模板演进 rung（W2 ensure+repair）、W3-entry 原子组合事务原语（P2-3）——全部构建 + 逐一 mutation-verified。**owner 复核的 P2（发货 index.ts runner 未被测）已修**：加 host 集成测试真调 `MetaSheetServer.createCoreAPI().multitable.provisioning.runObjectFieldsRepairTransaction`，照 reviewer 原样把发货 runner 改恒抛 ⇒ 该测试 RED（其余套件仍绿），runner-vs-prod gap 真正闭合。**尚余**：fresh CI（已 dispatch 运行中，跑 real-DB 白名单）+ **owner exact-head 短复审** —— 二者过后才宣布 W2/P2-3 clean。余下能力项（W3/G1/P0/P5/P7/P-T3）全卡在 owner 决策 / 未合依赖 / 需求门。

---

## 2. 已建成 + 验证矩阵（全 unarmed，flag-gated，零接 live 路径）

| 能力 | 内容 | 验证（承重证） |
|---|---|---|
| **P1a 地基实证** | 9 张 `plm_stock_preparation_*` 是**真 multitable**（provisioning 写 meta_sheets/fields/views）；插件写路径（refresh/apply/sync/confirm）**不发自动化事件**（负例★） | `stock-prep-substrate-p1a-realdb.test.ts` 4/4（专属库；含零-outbox 负例） |
| **P1b ext_ 命名空间** | 租户扩展列前缀纪律 `ext_`，`assertExtensionFieldIdValid` | CJS 套件；变异独立复跑 |
| **P4 跨批继承（carry-policy）** | `carryKey` component_source_id；1→N→`MANUAL_CONFIRM` 绝不静默；同 key 冲突内容→hold；冻结 `CARRY_CONFLICT_TYPES`/`CARRY_POLICY_ERROR_REASONS`（deepEqual exact-pin + `fail()` 运行时校验 + 源级不变量：每个 `fail('REASON')` ∈ 词表） | CJS 套件；exact-vocab / coarse-details / 源级不变量各 mutation RED |
| **P3 建议算子** | `computeDemandDateCascade`（无节假日）+ 跨项目预填候选（rankBy recency/field_presence）；只发建议列 | CJS 套件 |
| **W2 模板演进 rung** | additive-only `ensureMissingObjectFields`（ON CONFLICT DO NOTHING）；MVP/canonical **governed repair**（admin / 只修缺集 / plm_system·ext_ 限定 / human_preserved reject 承重 / 与 fresh 同构含 `stockPreparationMvp` 元数据 / 并发抢插 fail-close / 写后完整性复核 / 既有列 name·type·property·**order** 前后快照）；DB-backed 字段发现（`resolveExistingObjectFieldIds`/`readObjectFieldsContent`，非 compute-only） | CJS 套件（fresh-vs-repair 同构 / race fail-close / INCOMPLETE / MUTATED / order 各 mutation RED）；`stock-prep-w2-scoped-repair-realdb.test.ts` 经真实 scope wrapper 端到端 |
| **P2-3 原子组合事务原语** | host `runObjectFieldsRepairTransaction` = 被测 glue `runObjectFieldsRepairTransactionWith(withTxQuery, fn)` over `poolManager.transaction`；tx-surface 由 `buildObjectFieldsRepairSurface(query)` 单点绑定四方法；plugin-scope 对 tx-surface 的**读/写方法**（resolve/read/ensureMissing）仍套 `assertObjectScope`，`findObjectSheet` 为 discovery-only（仅 project-namespace 校验，与非 tx findObjectSheet 一致）；canonical/MVP repair 全体挪进单事务（MVP 多表 all-or-nothing）；抛错⇒ROLLBACK（原子 fail-close，非 post-commit 检测 canary） | `realdb 原子回滚证明`（after-read 注入 mutation⇒守卫在 tx 内抛⇒additive INSERT 回滚⇒字段仍 missing；变异 ROLLBACK→COMMIT⇒RED）；`buildObjectFieldsRepairSurface` 单测（每方法走同一 query，逃逸⇒RED）；glue 单测（throw 传播⇒rollback，吞 throw⇒RED）；scope tx-surface pin（删 assertObjectScope⇒RED）；503 契约 pin（削弱 getXxxRepairApi⇒RED） |
| **P2/P6 config-pack docs** | 手工 runbook + template-library（不含权限/自动化导入，诚实不谎称可导入） | 文档 |

**全量门**：`tsc` 0 error · plugin CJS 链 **103/103** · scope 单测 **12/12** · provisioning 单测 **11/11** · W2/P4 realdb **16/16**（含原子证明）。

---

## 3. 余下开发盘点：目标可否设 + 门 + 模型 + 排序

**"无外部门卡、可现在建"的开发 = 0**（P2-3 是最后一个，已建成）。以下全部**被门卡**——可设为目标，但每项须先由 owner 解门；解门后按难度分配模型。排序 = 解门后的建议实施序。

| 序 | 项 | 卡在哪（门） | 解门后模型 | 难度理由 |
|---|---|---|---|---|
| 1 | **W3 建议列消费**（suggestedDemandDate 等接线：模板加 plm_system 列→repair 装表→接算子） | owner 侧审过 W2 + 本 P2-3 → 然后 flag arm | **sonnet5** | 机制已备（§3.3a 原子兜底 + P3 算子已建），接线为主，非新设计 |
| 2 | **G1 emit-seam**（批次刷新→通知部门；插件写路径新增自动化事件出口） | 设计门（新 emit seam，触碰写路径 side-effect） | **opus4.8** | 跨写路径 side-effect + 幂等/去重 + 对抗验证，核心刀 |
| 3 | **P0 生产激活**（canonical apply 打开） | owner config 决策（已接线 #3199，只差开关+真库配置） | **sonnet5**（配置+验收） | 代码已在，主要是受控 arm + 真库预演 |
| 4 | **P5 图号 profile** | D2（#4520）未合依赖 | **fable5** | 依赖合并后为规则/映射扩展，量中等 |
| 5 | **P7 第二场景** | D 线第二 scenario 拉动（无需求源） | **fable5** | 场景复制，待需求 |
| 6 | **P-T3 K3/ERP 写回 go-live** | 需求门（真 go-live 前置，大）+ 外部系统凭据/合规 | **opus4.8** | 外部写 + 事务/回滚/审计 + 合规，最重 |

**模型分配原则**（沿用本线纪律）：核心/跨包/side-effect/外部写 + 需对抗验证→**opus4.8**；接线/配置/受控 arm/真库验收→**sonnet5**；规则扩展/场景复制/量活→**fable5**。

**可并行性**：解门后 1(W3) 与 3(P0) 可并行（不同路径）；2(G1) 因触碰写路径，宜串行、独立对抗审后再并；4/5 待依赖；6 独立需求门。

---

## 4. 验证纪律与审阅轨迹

- **实证优先**：地基断言（9 表真 multitable + 插件不发事件）从"读代码以为"升级为"真库跑出来"；负例是审阅逼加的。
- **pre-ratify 不 arm**：所有模块新文件落地、守卫入 CI，**零接 live 路径**；共享文件 hook 精确记账；ratify 后机械接线。
- **变异承重**：每条守卫都跑过"禁用守卫→测试必 RED"；断言不发生必配正控；冻结词表 deepEqual + 运行时消费者 + 源级不变量三层。
- **审阅轨迹（此刀跳过首审→连吃多轮 HOLD，教训入 [[feedback_adversarial_review_before_pushing_core_cross_package]]）**：
  - R1 2P1+3P2 / R2 1P1+2P2 / R3 4P2 / R4 独立审 1P3+2NIT / R5 owner-codex 0P1+3P2+2P3 — 全修 + 逐一 mutation-verified。
  - **P2-3 建成后**经**两轮独立对抗审**：① 工作流 3-lens（worktree 隔离）0 阻塞、5 P3 全闭合（发货 runner glue 抽取可测 / 503 契约 pin / 文档同步）；② 直接 adversarial-reviewer（Opus，worktree 隔离）**APPROVE 0 P1 / 0 P2**——全部安全/正确守卫逐一 mutation-verified 承重（各 RED-under-neuter），确认 unarmed。其抓的唯一真 NIT（hermetic 单测未钉 write 绑定：空 fields 不发 SQL）已修（传非空 fields，write 逃逸⇒RED）。**advisor** 抓的盲点（coarse-details 无 pin）以源级不变量补齐。
  - **审阅认可的 residual（不阻塞、非本刀引入）**：(a) MVP 多表 all-or-nothing 回滚**无直测**——单事务包裹逻辑上蕴含、canonical 单表回滚已证，标 **W3**（需多表 realdb 中途失败用例）；(b) `.cjs` 守卫测试**不在 CI**——STANDING/既存（house memory「plugin-integration-core tests NOT in CI」），修=接 CJS 链进 CI，另议。P2-3 的原子实质**已 CI 覆盖**（`stock-prep-w2-scoped-repair-realdb.test.ts` 在 plugin-tests.yml:487 DATABASE_URL-gated 步、单测在 core-backend 默认步）。
- **runner-vs-prod 纪律**：发货 `index.ts` runner 抽成被测 `runObjectFieldsRepairTransactionWith` + `buildObjectFieldsRepairSurface`，realdb 与单测都覆盖发货代码，避免"测试自建 runner 空转"（[[feedback_runner_vs_prod_version_gap_vacuous_test]]）。

---

## 5. 诚实边界

- **本轮把可建的全建了**：可并行、不需门的 slice 全部构建 + 验证；P2-3（原 W3-entry 门）按 owner「完成所有开发」指令已建成。
- **没有把任何 gated 特性偷偷 arm 进承重路径**：repair 仍 unarmed / 未接生产路由；接线是 W3 事、现有原子 fail-close 兜底。
- **余下全是 owner 决策 / 未合依赖 / 需求门**（§3）——非代码侧能单方推进；每项解门后按 §3 的模型与序执行。
