# MetaSheet2 vs Teable 开源对标（多维表平台）2026-05-25

文档性质：开源对标研究。docs-only，不解锁任何 runtime。
对标目的：**读开源代码、把可迁移的实现模式带回我们 Node/TS + Postgres 后端**。目的不同则选型不同（见 §2）。
方法：我们一侧来自对本仓三子系统（multitable / automation / approval+BPMN）的深度读码（含 file:line 锚点）；开源一侧来自各项目官方仓库 + 文档的实证（2026-05-25 核对，附 §9 来源）。

## 1. 一句话结论

在「能当作单一 codebase 深读、且整平台最贴我们」这个标准下，**Teable** 是最佳对标对象：同栈（TS + Postgres），覆盖我们三条可比面中的两条（多维表核心 + 实时协作），是当前最活跃的 Airtable 开源替代。

但有两条诚实边界，决定了它不能独家承担对标（§7）：

- **存储是根本分歧**：Teable 把数据落进**真 Postgres 表（一字段一列）**，我们是 **JSONB blob（一记录一 `data` 列）**。Teable 的招牌能力建在这个分歧上，不能直接迁移。
- **Teable 的自动化是 Enterprise 闭源**：AGPL 的 CE **没有可读的自动化代码**。而自动化恰是我们在研的主轴，所以该维改读 **Baserow**（MIT、有 router/condition/formula 节点）。

## 2. 对标目的 → 选型

| 目的 | 最佳对标 | 理由 |
|---|---|---|
| 读码迁移到我们 TS 后端（本文采用） | **Teable** | 端到端 TS 单体；同栈；多维表+协作可读 |
| 产品功能 parity（与 宜搭/yida benchmark 同竞品集） | **APITable（维格表）** | OSS 中文多维表 genre 孪生；robots+表单+BI |
| 自动化引擎架构参照（PLAN-Automation） | **Baserow** | Automations Builder 有 router/分支/条件/公式；前端也是 Vue |

单轴（非整平台）参照：n8n（纯自动化模式）、Camunda/Flowable（BPMN 语义）、bpmn-js（设计器）、pg-boss/Graphile Worker（Postgres 持久队列）。

## 3. MetaSheet2 是什么（grounded 刻画）

一个 **Node/TS + Express + Postgres** 的多维表平台（Airtable/多维表 DNA），上层叠 automation + approval；**Vue3** 前端；**JSONB cell 存储**；**Yjs CRDT** 实时协作；深度钉钉集成；workspace 多租户。三套流程子系统并存：multitable automation（线性 trigger→action）、approval product（成熟 DAG 状态机）、BPMN（自研实验性，与 approval 独立运行时）。

- 后端栈：`packages/core-backend/package.json` — express 4 / kysely 0.28 / pg 8 / ioredis / socket.io / node-cron / xml2js / zod。
- 前端栈：`apps/web/package.json` — vue 3.5 / pinia / element-plus / vite 7 / yjs 13.6 / socket.io-client。

## 4. 八维对照（Teable 为脊）

| 维度 | MetaSheet2（我们） | Teable | 迁移价值 |
|---|---|---|---|
| 后端 | Node/TS · Express · kysely | Node/TS · **NestJS** · Prisma | 高 — 同语言 |
| 数据库/缓存 | Postgres · ioredis | Postgres(+SQLite) · Redis | 高 — 同栈 |
| 前端 | **Vue3** · element-plus | Next.js（**React**） | 低 — 框架不同 |
| 存储模型 | **JSONB blob**（`meta_records.data` 一列；`field-codecs.ts`） | **真 Postgres 表，一字段一列**（无抽象层，可被任意 PG 工具直查） | ⚠️ 岔路（§7.1） |
| 字段类型 | 26 种含 link/lookup/rollup/formula（`field-codecs.ts:4-31`） | 自定义列 + formula + attachment + 字段转换（具体清单未公开枚举） | 中 |
| 视图 | grid/kanban/calendar/gallery/form/gantt（6；`db/types.ts:184`） | Grid/Form/Kanban/Gallery/Calendar（5，无 Gantt） | 中 — 近一致 |
| 实时协作 | **Yjs CRDT + WS**，flag `ENABLE_YJS_COLLAB`（`collab/yjs-*`） | 实时协作 + live cursor（**机制官方未公开**，不臆断 CRDT/OT） | 中 — 机制待查 |
| 自动化 | 线性 trigger→cond→action（8 触发/~10 动作，非 DAG，无分支/循环；`automation-service.ts:45-67`） | **EE 闭源**；CE 无开源自动化码（§7.2） | ⚠️ 改读 Baserow |
| 权限 | base/sheet/view/field/record 五级（`permission-derivation.ts`） | space/base/table/field（granularity 官方未细列） | 中 |
| 表单 | 公开表单 + token 分享（`record-history-service` source='public-form'） | Form view（公开表单细节未在 README 公开） | 中 |
| 多租户 | workspace 维度（`meta_bases.workspace_id`） | space（EE authority matrix） | 中 |
| License | 私有 | **AGPL（CE）/ EE 私有** | 仅读码对标，不 fork，无碍 |

## 5. 三处最值得读 Teable 的地方（actionable）

1. **真 Postgres 表存储的取舍**（最高价值）：Teable「无抽象层、一字段一列」让 formula 可下推到 Postgres 表达式、按列建索引扛规模、外部工具直查。读它如何做 schema 演进（加字段=加列）与类型转换，对照我们 JSONB blob 的查询/聚合短板（§7.1）。
2. **NestJS 模块边界**：同为 TS 后端，Teable 的 NestJS 分层（field/view/record/collab module）可对照我们 Express + service 的组织方式，迁移成本低。
3. **实时协作落地**：我们已选 Yjs（CRDT）。Teable 的实时机制虽未公开，但其 live-cursor/presence 的前端处理可对照我们 `MetaYjsPresenceChip` / presence 类型。

## 6. 自动化轴：改读 Baserow（Teable 此处闭源）

我们的自动化是**线性、fail-stop、非 DAG**（无分支/循环/错误处理节点；`automation-executor.ts:578-661`），调度是**内存 timer + Redis leader lock**（非持久队列；`automation-scheduler.ts`），无 retry/idempotency/trigger-event 快照。

**Baserow 的 Automations Builder（MIT-core，可读）** 正好补齐我们缺、且 PLAN-Automation 想要的方向：

| 能力 | 我们 | Baserow Automations Builder |
|---|---|---|
| 执行模型 | 线性 1..N | 含 **router 节点**（分支） |
| 条件 | 嵌套组（5 层），rule 级 AND | conditions + **formulas + variables** |
| 运行历史 | execution + steps（无 trigger 快照、无 retry） | 触发/动作 + 运行记录 |

→ Phase 3「编排节点」与 Phase 4「运行治理」选型时，**Baserow 是代码可读的首选参照**；Teable 的自动化只能当**功能参照**（读文档不读码）。APITable robots 为 AGPL 可读但 Java/多语言。

## 7. 两条诚实的迁移边界

### 7.1 存储分歧——别期待 drop-in

Teable 的杀手锏（SQL 直查、Postgres 表达式 formula、按列索引）**依赖「真表」模型**，迁不进我们的 JSONB blob。但这正是对标**最有价值**的部分：它是我们平台走过的具体岔路口。看清取舍——我们的 JSONB 换来了「动态 schema 零迁移、字段即 JSON key」，代价是「跨记录聚合/查询要解 blob、`lookup`/`rollup` 须自研引擎」。是否、以及在哪些热表上引入「物化列/生成列」是可单独评估的后续题（非本文范围）。

### 7.2 Teable 自动化闭源

README 明示 EE 才含 automation；CE（AGPL）无开源自动化码。故自动化轴的**代码级**对标只能走 Baserow（§6）。这条若不点明，会误以为「读 Teable 就能学自动化」。

## 8. Lock / 范围声明

本文 docs-only、锁安全，属**调研储备**，不是 K3-gate 工作，也不与正在推进的 K3 reference-mapping 链抢 runtime。任何由本文引出的实现（如存储物化列、自动化 DAG）均须独立 scope-gate + 显式 opt-in；K3 stage-1 lock 期内下游 Phase 2/3-6 仍冻结。

## 9. 来源

- 我们一侧：本仓深度读码（multitable / automation / approval+BPMN），file:line 锚点见正文。
- Teable：<https://github.com/teableio/teable> · 自动化文档 <https://help.teable.ai/en/basic/automation>（automation 标注为 EE）。
- Baserow：<https://github.com/baserow/baserow>（Django+Vue+PG；Automations Builder：triggers/actions/router/conditions/formulas/variables；MIT core + 私有 premium/enterprise）。
- APITable：<https://github.com/apitable/apitable>（TS Next.js+NestJS + Java Spring Boot；OT collab；robots 自动化；AGPL）。
- 横向：<https://openalternative.co/alternatives/airtable>。
