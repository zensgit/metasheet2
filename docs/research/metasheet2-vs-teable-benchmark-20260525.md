# MetaSheet2 vs Teable / NocoBase 源码级对标 2026-05-25

文档性质：开源对标研究。docs-only，不解锁任何 runtime。
对标目的：**读开源真源码、把可迁移的实现模式带回我们 Node/TS + Postgres 后端**。
方法：三方均为**源码级**阅读（非 web 摘要）。我们一侧 = 本仓 multitable / automation / approval 深读；对标一侧 = `references/` 下的真源码（见 §9 provenance），含 file:line 锚点、关键处亲验。
选型脊柱：**Teable** = 数据平台轴（同栈 TS+Postgres，真表存储）；**NocoBase plugin-workflow** = 工作流引擎轴（同栈、微内核插件、DAG + 挂起/恢复）。

> **路径约定**：本文所有代码引用均为**完整 workspace-relative 路径**（相对仓库根 `/Users/chouhua/Downloads/Github/metasheet2/`）。我方代码在 `packages/core-backend/src/…`；外部语料在 `references/<project>/…`（该目录经 `.git/info/exclude` 本地忽略、不在 git、**不在本 PR 的 worktree**，复现见 §9）。

## 0. 源码读对 web 实证版（v1）的两处纠正（可审计）

v1（本文首版）基于 web 摘要，有两处被真源码推翻，本版已改：

| # | v1 错误结论（web） | 源码实证（亲验） |
|---|---|---|
| C1 | 「Teable 自动化是 Enterprise 闭源，CE 无可读自动化码」 | **错**。CE 含完整自动化引擎：`references/teable/apps/nestjs-backend/src/features/automation` **52 文件 / 3751 行**，基于 `json-rules-engine`；3 触发 + 5 动作（含 `Decision` 分支节点）。见 §4 |
| C2 | 「Teable 实时协作机制未公开，不臆断 CRDT/OT」 | **已知**。用 **ShareDB（OT）**：`sharedb@4.1.2` + `sharedb-redis-pubsub`，`Ops`/`Snapshots` 版本化表。我们用 **Yjs（CRDT）** —— 真正的算法岔路。见 §3 |

衍生修正：v1 §6「自动化轴改读 Baserow，因 Teable 闭源」——**前提不成立**。Teable CE 自动化可读；且 `references/nocobase` 已有更强的同栈 DAG 工作流引擎。**故本版不引入 Baserow**（未克隆、不需要），自动化轴走 Teable-automation + NocoBase-workflow 两个**真源码**参照。

## 1. 一句话结论

- **数据平台**怎么搭：读 **Teable** —— 同栈、真 Postgres 表存储、字段即列。
- **工作流/自动化引擎**怎么搭：读 **NocoBase plugin-workflow** —— 同栈、DAG + 节点挂起/恢复（manual/delay），正是我们线性引擎所缺、且 approval+automation 收敛需要的。
- Teable 自身的 `json-rules-engine` 自动化是**第二个**可读自动化参照（带 Decision 分支，已超过我们的纯线性）。

## 2. MetaSheet2 是什么（grounded）

**Node/TS + Express + Postgres** 多维表平台（Airtable/多维表 DNA），上层叠 automation + approval；**Vue3** 前端；**JSONB cell 存储**；**Yjs CRDT** 协作；深度钉钉集成；workspace 多租户。三套流程子系统并存：multitable automation（线性 trigger→action）、approval product（成熟 DAG 状态机，含版本冻结/三合并/管理员跳转/Resolver）、BPMN（自研实验性，独立运行时）。

## 3. 数据平台轴：我们 vs Teable（源码级）

| 维度 | MetaSheet2 | Teable |
|---|---|---|
| 后端 | Node/TS · Express · kysely | Node/TS · **NestJS** · Prisma · **Knex**(DDL) |
| 存储模型 | **JSONB blob**：每记录一个 `meta_records.data`（`packages/core-backend/src/multitable/field-codecs.ts`） | **真物理表**：每用户表一张 PG 表、每字段一列 |
| └ 建表 | 逻辑表=`meta_sheets` 行 | 运行时 `knex.schema.createTable(dbTableName,…)` + `$executeRawUnsafe`，系统列 `__id/__auto_number/__version/__created_*`（`references/teable/apps/nestjs-backend/src/features/table/table.service.ts:107-119`） |
| └ 加字段 | JSON 加 key（无 DDL） | 运行时 `alterTable(…).table[typeKey](dbFieldName)`（`references/teable/apps/nestjs-backend/src/features/field/field.service.ts:128-138`） |
| 字段类型 | 26 种含 link/lookup/rollup/formula（`packages/core-backend/src/multitable/field-codecs.ts:4-31`） | 22 逻辑类型（`references/teable/packages/core/src/models/field/constant.ts`）→ 7 物理 `DbFieldType`（多值/Link 落 JSON；`references/teable/apps/nestjs-backend/src/features/field/field-calculate/field-supplement.service.ts:358`） |
| Formula | 自研引擎 `{fld_xxx}` + 跨表 lookup/rollup（`packages/core-backend/src/multitable/formula-engine.ts`） | **Node 应用层逐行算后写回列**（`references/teable/apps/nestjs-backend/src/features/calculation/field-calculation.service.ts`）；**非**下推 PG 表达式、**非** HyperFormula（`grep -ri hyperformula references/teable` = 0 命中）；公式解析用 ANTLR（`references/teable/packages/formula`，MIT） |
| 实时协作 | **Yjs（CRDT）** + WS，flag `ENABLE_YJS_COLLAB`（`packages/core-backend/src/collab/yjs-*`） | **ShareDB（OT）**：`sharedb@4.1.2`+`sharedb-redis-pubsub`，`Ops`/`Snapshots` 版本化表（`references/teable/apps/nestjs-backend/package.json`；`references/teable/packages/db-main-prisma/prisma/template.prisma:129-152`；`references/teable/apps/nestjs-backend/src/ws/ws.gateway.ts`） |
| 视图 | grid/kanban/calendar/gallery/form/gantt（6；`packages/core-backend/src/db/types.ts:184`） | 6：Grid/Calendar/Kanban/Form/Gallery/Gantt（`references/teable/packages/core/src/models/view/constant.ts`） |
| 表单 | 公开表单 + token（`packages/core-backend/src/multitable/record-history-service.ts` source='public-form'） | `View.enableShare/shareId/shareMeta` + `share` 特性，Form view 可公开（`references/teable/packages/db-main-prisma/prisma/template.prisma:115`） |
| 权限 | base/sheet/view/field/record 五级（`packages/core-backend/src/multitable/permission-derivation.ts`） | space/base/table/field |
| License | 私有 | **AGPL（CE）/ EE 私有** |

**最值得读 Teable 的三处**：① 动态 DDL 存储（建表/加列/类型转换/删列）—— 我们 JSONB blob 没有的能力，对照看取舍（§6.1）；② NestJS 模块边界（`references/teable/apps/nestjs-backend/src/features/{field,record,calculation,share}` 分层）对照我们 Express+service；③ **ShareDB(OT) vs 我们 Yjs(CRDT)** 的协作算法选型差异 —— 这是本文在数据平台轴的**独有**贡献（并行公式对标文档明确不含协作，见 §7）。

> **存储模型 + 派生值/公式引擎（lookup/rollup/formula）的逐文件深读，已由并行文档 `docs/research/multitable-vs-teable-hyperformula-comparison-20260526.md` 覆盖到比本表更深的层次**（递归 CTE 依赖闭包、物化、ANTLR、ComputedUpdate outbox 等）。本文该轴只取至「结论 + 选型理由」，深度对照见 §7 链接，不重复。

## 4. 工作流/自动化轴：我们 vs Teable-automation vs NocoBase-workflow（源码级）

这是收益最高的一轴 —— 我们的自动化是**线性、fail-stop、非 DAG、无挂起/恢复**，两个参照都超过我们，且 NocoBase 的能力正对 PLAN-Automation + approval/automation 收敛。

> NocoBase 工作流插件根 = `references/nocobase/packages/plugins/@nocobase/`；下文 NocoBase 锚点均以此为前缀的完整路径。

| 能力 | MetaSheet2 | Teable automation | NocoBase plugin-workflow |
|---|---|---|---|
| 执行模型 | **线性 1..N，fail-stop** | DAG（`parentNodeId/nextNodeId`）+ `json-rules-engine` | **分支 DAG**（`upstream/downstream`+`branchIndex`），`Processor` 驱动 |
| 分支 | ❌ 无 | ✅ `Decision` 动作节点 | ✅ `condition`/`parallel`(ALL/ANY/RACE) |
| 循环 | ❌ 无 | ❌ | ✅ `plugin-workflow-loop`（`looped/done` 计数 + `WORKFLOW_LOOP_LIMIT`） |
| **挂起/恢复** | ❌ 无（同步跑完） | ❌ | ✅ **一等公民（亲验，见表下锚点）** |
| 触发 | 8 类(record/field/schedule/webhook) | 3 类(RecordCreated/Updated/MatchesConditions) | collection/schedule/action(可扩展) |
| 动作/节点 | ~10 类 | 5(Webhook/Mail/CreateRecord/UpdateRecord/Decision) | 核心 create/update/destroy/query/calculation/condition/end + 插件 request/sql/aggregate/notification/cc… |
| 状态模型 | 4 态(running/success/failed/skipped) | 执行历史表 | **9 态** QUEUEING/STARTED/RESOLVED/FAILED/ERROR/ABORTED/CANCELED/REJECTED/RETRY_NEEDED |
| 持久化 | `multitable_automation_executions`+steps（无 trigger 快照） | `AutomationWorkflowExecutionHistory` | `workflows`/`flow_nodes`/`executions`/`jobs`/`workflowManualTasks` |
| 调度 | 内存 timer + Redis leader lock（非持久队列） | — | 持久 execution + job，可跨秒/天 |
| 重试 | 仅 webhook 2 次退避 | — | `RETRY_NEEDED` 态有定义（核心无自动重试） |

**file:line 锚点（完整路径）**：
- 我方：执行模型 `packages/core-backend/src/multitable/automation-executor.ts:578-661`；触发 `packages/core-backend/src/multitable/automation-service.ts:45-54`；动作 `packages/core-backend/src/multitable/automation-service.ts:56-67`；调度 `packages/core-backend/src/multitable/automation-scheduler.ts`。
- Teable：分支 `references/teable/apps/nestjs-backend/src/features/automation/enums/action-type.enum.ts`；触发 `references/teable/apps/nestjs-backend/src/features/automation/enums/trigger-type.enum.ts`；执行历史 `references/teable/packages/db-main-prisma/prisma/template.prisma:283`。
- NocoBase（亲验）：状态枚举 `references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/constants.ts:10-30`（`JOB_STATUS.PENDING=0` :23）；delay 挂起+恢复 `references/nocobase/packages/plugins/@nocobase/plugin-workflow-delay/src/server/DelayInstruction.ts`（`return null`+`status:PENDING` :107/118、`resume()` :121、timer `workflow.resume` :95）；manual 挂起 `references/nocobase/packages/plugins/@nocobase/plugin-workflow-manual/src/server/ManualInstruction.ts`（建 `workflowManualTasks.createMany` :121、`resume` :138）；恢复分发 `references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/Dispatcher.ts:125`；分支/并行 `references/nocobase/packages/plugins/@nocobase/plugin-workflow-parallel/`、循环 `references/nocobase/packages/plugins/@nocobase/plugin-workflow-loop/`、节点注册 `references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/instructions/`。

**核心洞见**：NocoBase 的 **job 挂起/恢复模型**（`JOB_STATUS.PENDING` + 持久 `jobs` + 外部事件 `resume()`）是把 **approval 的人工节点**和 **automation 的延时/等待节点**统一进**一个引擎**的关键 —— 它正好同时解决我们 (a) approval 与 automation 双引擎割裂、(b) 自动化无分支/循环/挂起、(c) PLAN-Automation 想要的 DAG 编排 三个问题。这是本对标最有迁移价值的发现。Teable 的 `Decision` 节点则示范了最小可用的「分支」起步。

## 5. 该实际拿走什么（actionable，均须独立 scope-gate）

1. **自动化加「分支/Decision 节点」**：起步参照 Teable `Decision`（最小），目标参照 NocoBase `condition`/`parallel`。补我们线性引擎最大短板。
2. **引入「挂起/恢复 + 持久 job」模型**：参照 NocoBase `Processor`/`jobs`/`PENDING`+`resume()`。这是 approval+automation 收敛与「延时/等待节点」的地基，也是 PLAN-Automation A4/A5（retry/trigger 快照）的天然载体。
3. **执行快照 + 状态模型加厚**：参照 NocoBase 9 态 + `executions/jobs`，对照 PLAN-Automation A1（trigger_event/rule_snapshot 快照）。
4. **存储热表「物化列/生成列」评估**：参照 Teable 动态 DDL，对我们 JSONB blob 的跨记录聚合短板做**局部**优化（非全量改造，§6.1）。

## 6. 诚实边界

### 6.1 存储分歧——不能 drop-in
Teable 的杀手锏（SQL 直查、按列索引、列级类型）**依赖真表模型**，迁不进我们 JSONB blob。但这正是最有价值的对照：我们 JSONB 换来「动态 schema 零迁移、字段即 key」，代价是「跨记录聚合/查询要解 blob、lookup/rollup 须自研引擎」。是否在**个别热表**引入物化列是可单独评估的后续题。

### 6.2 法律/许可（按部位区分，落地前必读）
`references/` 已在 `.git/info/exclude` 本地忽略，**永不提交**外部源码。许可证**不是整仓一刀切**：

- **Teable**：`references/teable/apps/*`（含 `nestjs-backend`，即 `calculation`/`field`/`automation` 服务）= **AGPL-3.0**，仅借鉴模式；但 **`references/teable/packages/*`（`core` 字段域、`formula` ANTLR 解析器、`db-main-prisma` schema）= MIT** → 可改用/改写。
- **NocoBase**：`plugin-workflow*` = **AGPL-3.0**，仅借鉴模式。
- **APITable**：AGPL-3.0。

读 AGPL 源码研习架构始终合法；**严禁把 AGPL 源码拷进我们闭源代码库**。本对标只描述架构/模式 + file:line 锚点，不复制实现。

## 7. 交叉引用 / 盘上其它参考

- **并行对标（已读其内容，非据文件名臆测）**：`docs/research/multitable-vs-teable-hyperformula-comparison-20260526.md`（另一 session 出品，逐文件深读）。其范围 = **存储模型 + 派生值引擎**（lookup/rollup/formula），三方为 metasheet2 / Teable `calculation` / **HyperFormula**（HyperFormula 是对标**我们网格 A1 引擎** `packages/core-backend/src/formula/engine.ts` 的第三参照，**不是** Teable 的引擎）。它**明确声明排除 UI/grid、协作(Yjs)、自动化** → 与本文（工作流引擎 + 协作 + 平台选型）**严格互补、零重叠**。其关键发现（本文据其引用）：Teable 用持久 `Reference` 边表 + 递归 CTE 闭包 + 物化进列 + `ComputedUpdate*` 异步 outbox/死信；并发现我们多维表 formula **跨写路径不一致**（仅 `POST /views/:viewId/submit` 触发 recalc、网格 PATCH 不触发）。存储/公式深度以那份为准。
- `references/apitable`（维格表，Java Spring Boot 核 + TS + React canvas，OT collab，robots 自动化，AGPL）——产品 genre 孪生，需 Java 跨语言阅读，本文未深读。
- `references/univer`（TS sheet 渲染引擎）——解释本仓 `packages/core-backend/src/routes/univer-meta.ts` 路由名来源；我们当前 grid 实为自研 Vue DOM，非 Univer。

## 8. Lock / 范围
docs-only、锁安全、调研储备；**非 K3-gate 工作**，不与 live K3 reference-mapping 链抢 runtime。§5 任一实现均须独立 scope-gate + 显式 opt-in；K3 stage-1 lock 期内 approval 下游 Phase 2/3-6 仍冻结。

## 9. 语料 provenance / 复现（reproducibility）

`references/` 语料在**主仓根目录**（`/Users/chouhua/Downloads/Github/metasheet2/references/`），经 `.git/info/exclude`（第 13 行）**本地忽略** → 不在 git、不在历史、**不在本 PR 的 worktree**。读者复现按下表各自获取（2026-05-26 核对）：

| 语料 | 路径 | 版本 pin | 获取命令 |
|---|---|---|---|
| Teable | `references/teable` | tarball@`main`（无 .git；main 为移动 ref，以下列命令 + 日期复现，非固定 commit） | `curl -fL --retry 6 https://codeload.github.com/teableio/teable/tar.gz/refs/heads/main \| tar xz` |
| NocoBase | `references/nocobase` | git HEAD `359b9ec`（v1.9.23） | `git clone https://github.com/nocobase/nocobase && git -C nocobase checkout 359b9ec` |
| Univer | `references/univer` | git HEAD `0f29c82` | `git clone https://github.com/dream-num/univer && git -C univer checkout 0f29c82` |
| APITable | `references/apitable` | v1.13.0（source tree，无 .git） | `git clone -b v1.13.0 https://github.com/apitable/apitable` |

> 注：`git clone` Teable 在本网络反复在 sideband packet 中断（curl 18 / early EOF），故用 codeload **tarball**（单次 HTTP GET，无 git 协议协商）。tarball 不含 `.git` → 无 commit SHA，只能用「main@日期 + 上述命令」pin；如需可复现的固定点，改用 `git clone --filter=blob:none` 取一个具体 commit。

**本文结论的亲验命令**（任何人可重跑核对）：
- Teable 自动化非闭源（C1）：`find references/teable/apps/nestjs-backend/src/features/automation -name '*.ts' | wc -l`（=52）+ `cat references/teable/apps/nestjs-backend/src/features/automation/enums/{trigger,action}-type.enum.ts`
- Teable 协作=OT（C2）：`grep -E '"sharedb' references/teable/apps/nestjs-backend/package.json`
- Teable formula 非 HyperFormula：`grep -ri hyperformula references/teable`（=0）
- NocoBase 挂起/恢复：`grep -n 'JOB_STATUS\|PENDING' references/nocobase/packages/plugins/@nocobase/plugin-workflow/src/server/constants.ts` + `grep -n 'PENDING\|resume\|return null' references/nocobase/packages/plugins/@nocobase/plugin-workflow-delay/src/server/DelayInstruction.ts`

正文所有其它 file:line 锚点均为完整 workspace-relative 路径，可直接定位。
