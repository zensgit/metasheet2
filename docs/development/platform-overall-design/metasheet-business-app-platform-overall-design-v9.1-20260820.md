# MetaSheet 业务应用平台化总体设计 v9.1（机械勘误·冻结稿）
## —— 备料 / 数据清洗 / HR / 售后 / 项目 / 排产 / 派工 / CRM 如何在多维表上"配置即应用"

- 日期：2026-08-20　**基线已冻结**：`zensgit/metasheet2` @ main `c5a4a94f7fc4ae8347ea9ad9da9fa446ccd87a4d`；migration head = Kysely `zzzz20260818120000_create_approval_usable_member_groups` / SQL `075_grant_sealed_export_runtime_authority_row_lock`；rebaseline 于 2026-08-20 完成,全部 P0-S/spike 驱动事实已在此 commit 重核成立(仅 workflow 路由行号整体 +1 漂移,见 §14)。
- 版本：**v9.1**（机械勘误版，冻结为 Ratification Review 输入）。v4/v5 合入 Codex 一轮 + 3 路 Opus；v6 二轮（收敛）；v7 三轮六项修正；**v8 合入 Codex 四轮(v7 深审)：BPMN 先关整条路由（纠正）、BPMN 租户模型代码事实（纠正）、external key 唯一约束矛盾（纠正 bug）、writer 统一 principal（纠多态外键）、同步动作拆三命令、mirror generation 原子发布、Source Mirror/Curated Master 分类、B2a 限时例外登记、Decision Register 加状态**,见 §14。
- 状态：**Ready for Ratification Review — Not Yet Design-Locked（Codex 五/六轮双方一致:停止 prose 往返,本 v9.1 机械勘误后冻结为评审输入,下一步产出转 ADR+migration+原型+测试+性能+回滚）**。P0-S 安全项可立即启动,不等模型 Ratify;P1 底座待 P0-D 三个模型阻塞项(BPMN 处置、principal 生命周期、mirror 存储拓扑)定案。**基线已冻结并 rebaseline 至 `c5a4a94f7`**(见前言);全部驱动事实重核成立。
- 输入：三份评估 + 十六份代码考古 + 五轮对抗校验 + **Codex 四轮复核(已收敛)** + 十处自我更正(其中两处由 Codex 四轮纠正:BPMN 租户列已存在、external key 约束矛盾)。
- 约定：`CB/` = `packages/core-backend/src/`，`CBM/` = `packages/core-backend/migrations/`，`MT/` = `CB/multitable/`，`PIC/` = `plugins/plugin-integration-core/`，`lib/` = `PIC/lib/`，`web/` = `apps/web/src/`。
- values-free；立项前按目标 commit 重跑核对与测试。
- **工程量单位约定（v7 统一）**：工程量一律 **人周（person-weeks, pw）**；日历周期单独标 **cw**；团队假设 backend×2 / frontend×1 / QA×0.5；owner 门与客户授权等待**单独列示，不计入工程量**。

---

## 0. 结论

**平台能力从真实应用里抽取；备料以现有窄链路先行受控验证，被验证的能力再迁入通用底座。** 备料 = 第一个业务灯柱；CRM-schema = 蓝图层一致性样板、CRM-sync = 外部数据层样板（P1 后）。应用形态 = **蓝图（数据）+ 可选领域插件（算法）**。

| # | 能力 | 何时 | 要点 |
|---|---|---|---|
| **0** | 主体模型与审计身份 | P0-D 锁定 / P1 落地 | `human / integration / automation / system_migration`；非人主体带租户、工作区、来源实例、权限范围、有效期、审计归属；服务端签发。论据：revision 已存在（三动作全覆盖），缺的是**可识别/可授权/可撤销**的具体系统主体 |
| 1 | 外部数据原语 | P1 | 归一化 binding + **writer grants 归一化表** + external key registry + **mirror-sheet 同步模型**；外部查找后置 |
| 2 | 主数据 | P1 建登记表（即 mirror），字段类型后置 | 跨 base link 引用登记表 |
| 3 | 统一待办 | **`@me` 不阻塞 P0-B1**（先用预置视图/当前用户参数化入口；通用算子 P1/P2）；聚合收件箱 P3 后 | 收件箱只做投影层 |
| 4 | 蓝图 / 安装 / 实例 / 升级 | P2（**破坏性 reconcile 保护提前到 P0-S**） | 三层：`app.manifest` · `blueprint` · `binding` |

两个横切物：**`plan → 人工确认 → apply`**（plan 绑定 binding 版本 content-key + registry 代际 + schema/policy/快照版本，apply 复验失配抛 `PLAN_STALE_BINDING_CHANGED`；plan 引用外部键而非记录 id；**plan 是生产写入的唯一边界**）；**领域算法 = 版本化可测试 preset 动作**。

---

## 1. 现状盘点（要点行；其余同 v6）

| 层 | 已有 | 证据 | 缺口 |
|---|---|---|---|
| 连接/凭据 | 宿主 `data_sources`（5 类适配器）；PIC `integration_external_systems`（tenant 级） | `CB/data-adapters/DataSourceManager.ts:54-61` | `data_sources` 无 tenant/workspace 列、作用域内存 Map、名称全局唯一；`assertAccess` 只比 ownerId（`:380-390`）→ 任何 tier/作用域模型前置 = 加列 + 回填 + 按表加载 + `UNIQUE(tenant_id,name)` |
| 主体 | `requirePrincipal` 拒绝 default/system/tenant/admin fallback | `CB/data-adapters/data-source-plugin-facade.ts:149-158` | 无 integration/system 主体 |
| 字段权限 | `field_permissions`（user\|role）+ `deriveFieldPermissions` + 约十处消费 | `CB/db/migrations/zzzz20260411140100…:14-26` | 主体维度无非人写者；插件 SDK 与自动化写路径不查它 |
| 自动化写 | create/update/delete 均同事务写 revision（`:2832/:2424/:2605`） | `MT/automation-executor.ts` | `:2290` 裸 patch 无 codec/只读/字段权限 |
| **插件作用域（安全）** | `assertPluginOwnsSheet` 未登记返回 `false` = **test-pinned legacy 容忍**（`tests/unit/multitable-plugin-scope.test.ts:298-306`） | `MT/plugin-scope.ts:152-171` | 宿主 `assertSheetScope` 钩子不检查返回值（与 UoW 路径 `:1884-1887` 不对称）；7 个调用点；无命名空间/租户/base 闸、无行级读拒绝 → **带迁移的安全契约变更** |
| **待办/任务（安全）** | 审批中心；BPMN `bpmn_user_tasks` + API | `CB/routes/workflow.ts` | **四处缺统一主体授权 + 原子状态机**（list `:386,415-429` / claim `:466-500` / **complete `:531-557` 零主体校验** / formData `:544-553` 授权外+事务外）；**租户列已存在但传播/过滤/强制断裂**（`bpmn_process_definitions/instances.tenant_id` 在，但 `getLatestVersion`/`getProcessDefinition` 不按它过滤、deploy 漏写、`/instances/:id` 缺租户限制）；list `selectAll()` 返回完整 variables/formData，需**安全投影**。**处置见 §7：P0-S 先关整条 runtime,完整授权模型 Deferred 至任务底座选型后** |
| 应用/模板 | additive 原语 `ensureMissingObjectFields` 已存在（`MT/provisioning.ts:523-540`） | `:314-321`（`ensureFields` 覆盖型） | **`ensureObject`（安装器实际入口，`installer.cjs:468`）内部仍调覆盖型 `ensureFields`（`:691`）→ 重装即覆盖租户改动，活路径**；manifest permissions **只声明、未运行时裁剪**（`CB/core/plugin-manager.ts:542-547`） |
| 其余 | 跨 base link opt-in；公式 117 函数；PM 视图；HR 底座；考勤独立 | 同 v6 | 同 v6 |

---

## 2–3. 两份备料评估（摘要，同 v6）

评估一（https://claude.ai/code/artifact/2bfcbaea-88a4-4dcc-afbf-6a0ba11b6f47）：知识可移植;**不将现有备料 runtime 模块整体搬入平台核心,但领域规则/映射算法/planner/fixture/SQL/UoW 约束/对账逻辑/验收测试可选择性复用或翻译**(修 v8"代码零复用"的绝对表述,Codex 五轮 §12);四条硬事实（ext_ / 生产 apply 三重门 / 零事件是治理约束 / UI 在 apps/web）；zip 默认视为已泄露 → 封 `/erp/*` + 轮换全部凭据。
评估二（https://claude.ai/code/artifact/d8def3b2-da43-4c98-8359-4279253aed56）：只对一条窄腿成立；**#4628 证的是 source-run 平铺路径**；最硬的轴 = 根选择 preset / 手工行 / 批次语义。

---

## 4. 外部数据原语（六项模型定案，均 Proposed）

### 4.0 横切纪律 + 能力 0（同 v6：两级信任 / 预览豁免提案 / writer-fence 旗标 / 主体四类 + `binding:<id>`）

**(e) 三类独立授权**：生产源读取 / 业务值面可见 / 目标生产表写入（K3 回写为后置第四项），各带 scope、审计、急停、撤销；**映射到既有门族**（OD-E / H0+H3-0+OD-W3-1 / FOS-4b-3-prod+autopersist），升格为按客户/按 binding 的一等授权，不另造治理。

### 4.1 原语 A：同步表（六项定案，均 Proposed 待 P0-D spike 定型）

**定案一：v1 锁定 one binding = one 逻辑 mirror（物理载体一或多，Codex 五轮 §5.3）。**
- 每个 binding 对应**一个逻辑 mirror**；内部可用一个或多个物理发布载体（见定案五 A/B）——故措辞是"逻辑 mirror"而非"物理 sheet",避免与双-sheet 发布方案字面冲突；`meta_sheets.active_binding_id` 与此自洽；
- **业务主表不被任何 binding 直接写**：`外部源 → mirror/staging 快照 → 生成 plan → 人工确认 → apply 业务主表`；同步期间只改 mirror，业务表不出现半批状态，也无需长时间抑制业务表自动化（`syncing`/allowed-stale 语义只适用于 mirror）；
- 纯字典/主数据表（物料主数据、项目登记表）mirror 即业务表，无人填列、无需 plan（或低风险 autoApply 作为后续门）；
- **旁证**：这正是备料线现行架构——source-run 落 MVP snapshot（= mirror），canonical 主表只经 gated apply（= plan 边界）。Codex 三轮独立重推出该形状，与二轮重推出三类授权门族一样，是对现有线设计的强验证。
- 避免的问题：writer 归属冲突、并发 apply、外部键冲突、一方失败一方已写、一表多 active binding、局部同步态不可解释。

**定案二：writer grants + principal 反向 FK（v9 再修：principal 成主体真源，消除残留多态）。** 迭代：v4 单枚举 → v5 allow-set → v7 grants 表 → v8 统一 principal 表 → **v9 反转引用方向**。v8 的 `automation_principals(kind, subject_id)` 仍是多态引用、只是把问题后移一层（DB 仍无法保证 subject 存在/同租户/生命周期一致，Codex 五轮 §4）→ 采**反向 FK**：
```
automation_principals(id, tenant_id, principal_type, state, created_at, revoked_at)   -- 主体真源
-- binding/automation/connector 等业务对象反向持有：principal_id FK → automation_principals.id
meta_field_writer_grants(field_id, writer_principal_id → automation_principals.id,
                         binding_id NULL, state, policy_version, constraints_json NULL)
```
- principal 的创建/撤销/租户归属/审计统一管理,不再依赖多态 `subject_id`(或为各业务对象建 subtype 表,各用真外键——P0-D 二选一);
- **grant 稳定归属绑 `binding_id`（identity），版本限制走 `constraints_json` 或独立 version-constraint 表——不让 `binding_version_id` 成为主归属（Codex 五轮 §5，修 v8 表述与结构不一致）；正常版本升级不丢授权**；
- **授权表是安全真源**；字段 `property` 只留缓存投影（客户端可改 property 不得作真源）；`value_origin ∈ {stored, computed}` 由字段类型派生、不存储；
- **合成顺序锁定（deny 优先）**：`computed deny → base/sheet deny → field_permissions deny → writer grant 失配 deny → record lock deny → allow`；
- `assertFieldWritableBy` = 在 `deriveFieldPermissions` 上扩 writer-principal 维度 + 读 grants，接管七条写路径（含客户端镜像同步改）。

**定案三：external key registry（v8 修正唯一约束与碰撞的矛盾）。** 原 `UNIQUE(binding_id, hash) WHERE active` + "命中后比 canonical" **自相矛盾**（唯一索引会在比对前就挡掉碰撞的第二条，Codex §6）→ 采方案 B：
```
UNIQUE(binding_id, normalized_key_hash, canonical_key) WHERE state='active'   -- 允许碰撞共存
UNIQUE(binding_id, record_id)             WHERE state='active'   -- 一条活动记录只对应一个活动键
-- canonical_key NOT NULL, normalized_key_hash NOT NULL, normalization_version NOT NULL
```
- 查询：先按 `hash` 取候选集，再比完整 `canonical_key`（hash 仅用于快速定位）；
- **DDL 明确（P0-D 定，Codex 五轮 §7）**：canonical_key 最大长度、hash 算法、`normalization_version` 及其升级/重建策略、key schema 变化是否触发新 registry generation、alias/history 唯一约束、active↔archived 切换的事务边界、**同一外部键不能同时指向两个 active record**；
- 源端重编号走**独立 alias/history 表**，不换主键；回收站恢复重激活；binding 删除而 sheet 保留 → registry 行归档；保留/压实进 §15；
- 键归一规则 + 批量查找合同（每块一次 `ANY($2)`，禁逐行 join）+ 按 binding 分区。

**定案四：同步动作拆五阶段状态机（v9 全文统一，Codex 五轮 §8）。** 内部状态机明确五段（`publish_mirror_generation` 是否作公开命令 P0-D 定，但必须是内部明确阶段）：
```
refresh_mirror_from_source  →  publish_mirror_generation  →  propose_business_apply  →  approve_plan  →  apply_plan
```
`sync_from_source` / `sync → snapshot → plan` 全文作废（§10、§11 P1 已同步改）。

**定案五：mirror generation 需物理存储拓扑,不能只切指针（v9 修，Codex 五轮 §6）。** 仅切 `active_generation_id` **不会让多维表的 view/formula/link/lookup/aggregation/automation/export/SDK/OAPI 自动过滤旧代**——同表两代会被默认读到。三方案：
- **A. 内部 staging 存储（推荐）**：新 generation 写系统内部同步存储,完整校验后**发布**到用户可见 mirror sheet;用户表**始终只含当前代**（读路径零改造）;
- B. 双 mirror sheet：每代独立物理 sheet,binding 原子切 active sheet,旧 sheet 保留期后清;
- C. 同表多 generation：**须所有读路径强制 `generation_id = active`——侵入多维表核心读路径,不作 v1 首选**。
`binding.active_generation_id` 仍是发布指针,但物理隔离走 A/B。"UI 显示同步中"不替代数据层原子发布。

**定案六："镜像即业务表"分类 + 运行时强制（v9 加强制，Codex 五轮 §9/§10）。** 判据 = "表里是否有必须永久保留的人工业务信息"：
- **Source Mirror**：外部源控制、连接器直刷。**运行时可执行策略**(非文档纪律)：`sheet_mode=source_mirror`、`schema_owner=binding`、`human_schema_mutation=deny`、`human_record_write=deny`;
- **Curated Master**：含人工信息,外部数据只能生成 plan、经确认才写;
- 客户要人工备注/分类 → **Source Mirror + 独立 Local Enrichment Sheet → Curated Master/Business View**,不在 Source Mirror 上直接加。

其余运行语义同 v6：分块 + 续跑游标；run 级修订；事件预算与熔断；急停不解绑；同步永不硬删；qualification 时序（probe 仅 Preflight 事务外）；不复用 FOS-4b-3-prod。

### 4.2 原语 B：外部查找 —— 后置 H3-0 之后（P4+，同 v6）
### 4.3 原语 C：入站推送（补治理，同 v6）
### 4.4 v1 不做（同 v6）

---

## 5. App Template（v7 两处提前/收紧）

三层分工、蓝图三表、反向导出、DSL 翻译层、`requiresCoreCapabilities`——同 v6。

**破坏性 reconcile 保护提前到 P0-S（不等 P2）**：已存在对象禁止无提示 destructive reconcile；重装/repair/enable 前生成字段 diff，name/type/property/order 有差异**默认拒绝**；只有具名 migration operation 可修改已有字段；修复路径显式走 `ensureMissingObjectFields` 或三方 diff seam；after-sales 安装器补**重入 + 租户修改保留**测试。
**归属长期方案**：`tenant:instance:app` 非末段只是兼容 `projectId.split(':').pop()` 的过渡；长期转显式字段 `tenant_id / app_id / instance_key / plugin_name`，安全归属不依赖字符串切分。
**manifest permissions 三态验收**：`declared → install-validated → runtime-enforced`；运行时 enforcement 落地前不得宣称"插件已被权限隔离"。
完整升级器（三方 diff / 弃用与数据迁移 / 租户修改保留 / upgrade ledger / 回滚 / dry-run 预览）仍在 P2。

---

## 6. 主数据（同 v6：B+ 首期 = 登记表 + 跨 base link；登记表即 mirror sheet；`masterRef` 后置；命名陷阱）

## 7. 待办 / 审批 / 确认 / 通知（同 v6 四分类）

**两套引擎的事实边界（已亲验）**：系统**在用的审批 = "审批中心" Approval 引擎**（`approval_instances/assignments/records/templates` + `ApprovalGraphExecutor` + ~40 个 `Approval*` 服务；考勤假勤/售后退款/钉钉审批卡/自动化 `start_approval` 全走它；Approval 服务**不碰任何 `bpmn_` 表**）。**BPMN 引擎（`BPMNWorkflowEngine` + `bpmn_user_tasks`）是平行的第二轨、基本休眠**：前端只有流程设计器消费 designer/deploy 接口，`/api/workflow/tasks` 及 claim/complete 在 apps/web 零调用、无业务线接入。

**BPMN 安全事实（v8 修正，已亲验 Codex §3–5）**：
- **路由无条件注册**（`CB/index.ts:1458`），**且现有 `DISABLE_WORKFLOW=true` 只跳过 `workflowEngine.initialize()`（`workflow.ts:30`），不停任何 HTTP 路由**——15 条 `router.get/post` 照常挂载 → 任何登录用户可达。**故需新加路由级 workflow runtime feature flag，入口直接返回禁用。**
- **BPMN 已有部分租户列**（`bpmn_process_definitions.tenant_id`、`bpmn_process_instances.tenant_id`，`zz20251231_create_bpmn_tables.ts:19,57`）——v7 说"归属链缺失"**过绝对，是本文表述错误**。准确结论：**列在，但传递/查询过滤/运行时强制断裂**（`getLatestVersion`/`getProcessDefinition` 收了 tenantId 却不按它过滤；deploy 时可能漏写 `tenant_id`；`/instances/:id` 按 ID 查缺租户限制）。
- **安全审计范围从 claim/complete/formData 扩到七面**：definitions / deployments / process-start / instance-detail / variables / **task-list（会泄露流程变量、formData、处理人、单据标识）** / history。→ **P0-S 先关整条 runtime 路由（含 list，不只关写）**；designer 若留则独立路由 + 租户授权；**选型前不做完整 BPMN 重构**。
- **本方案里的"任务"载体是"候选底座"，不是复用在用审批**：`bpmn_user_tasks` 的 assignee/candidate/claim 语义只是**建议**作派工/任务的基础 → 升为决策 **#16b 任务底座三选一**（详见下方"任务底座决策"）。**审批语义一律走在用的审批中心引擎，此决策只关乎"任务/派工"载体。**

**任务底座决策（#16b，可延、不阻塞备料主线）**

| 方案 | 语义贴合 | 现状 | 风险 | 后悔成本 |
|---|---|---|---|---|
| (a) 启用 BPMN 任务模型 | 高（认领/候选/完成现成） | 2082 行引擎，**无业务在用、无业务测试、四处授权漏洞** | 高（为一个场景发动没人开过的复杂机器并对它负责） | 高（重资产难退） |
| **(b) 新建轻量任务对象**（推荐默认） | 高（照需求裁剪 ready/claimed/done + 指派 + 产出） | 需新写，但只做需要的 | 低（隔离、可控、不拖累在用系统） | 低（不合适可重构，将来需复杂编排再升 BPMN） |
| (c) 塞进审批中心 | **低**（审批无认领/转派/报工语义） | 部分可用但须扭曲语义 | **高（改动正在跑考勤/售后的核心引擎）** | 高（污染难回收） |

**倾向 (b)**：BPMN 的价值在跨部门多分支带会签/定时器的复杂编排；若派工只是"接单→做→报工→完成"的直线流程，(a) 是杀鸡用牛刀且刀未开刃，(c) 是拿在用系统冒险。**判据（业务方回答即可定）**：① 流程是否直线（是→b；多分支/会签/超时升级→才考虑 a）；② 是否需要抢单/转派/报工产出（是→排除 c）；③ 未来是否有多种异构"任务"场景（是→更该做 b 一个通用底座）；④ 是否有人懂并愿长期维护 BPMN（否→别选 a）。**不阻塞性**：备料本身的审批走审批中心，**不依赖此决策**；派工/任务是独立应用，此项等派工需求真正立项、业务流程说清后再定（P0-D 或更晚）。
- **收件箱的"BPMN 任务"生产者今天流量为零** → 首期收件箱实际只有审批 + 提醒 + @提及三路，与"聚合收件箱 P3 后"排期一致。

**v8 修正 BPMN 处置（消除 v7 与 §7 前半的正文矛盾，Codex 五轮 §3）**：P0-S **只做一件事——`ENABLE_BPMN_RUNTIME=false` 默认、关闭整条 `/api/workflow`**（含 definitions/deployments/process-start/instance-detail/variables/message-signal/history，不只 `/tasks`）；designer 若留只保草稿/建模/本地编译预览，部署/启动/运行入口继续关。**完整 workflow 授权模型（`authorizeTaskAction`、租户归属强制、list 安全投影、候选组快照 vs 实时、离职处理、委托优先级、outbox 边界、并发条件）整体 Deferred——只有正式选定 BPMN 作任务底座后才投入,不进当前平台主线。** `@me` 不阻塞 P0-B1。

## 8. 应用 × 能力矩阵（同 v6；CRM 拆 **CRM-schema**（P2，纯蓝图）与 **CRM-sync**（P1 后，验证 binding/principal/字段归属/同步）——失败可归因到蓝图层或外部数据层）

## 9. 姿态继承（同 v6：values-free 双面纪律、sandbox-first 回滚证据、K2 对集成主体适用等）

---

## 10. 分层落点（v7 增量）

core 增：`meta_field_writer_grants` + 合成顺序实现；mirror-sheet 同步模型（业务表只经 plan/apply）；**BPMN runtime fail-closed gate（P0-S）**；`ensureObject` destructive-reconcile 守卫。其余同 v6（归一化 binding 四表、registry、`upsertByKey`、`plan` 对象、蓝图三表、OAPI upsert、整值绑定、`data_sources` 加列、每动作一条 CHECK 迁移；同步动作 = refresh_mirror→publish_generation→propose→approve→apply 五阶段）。**（v9.1：workflow 归属链/`authorizeTaskAction`/list 投影已随 #16a′ 整体 Deferred，从当前 core 增量移出——仅在正式选定 BPMN 作任务底座后才立项；`sync_from_source` 旧名已彻底删除。）**

---

## 11. 路线图（v7 重排：依赖冲突与范围重复已消除）

> 阶段命名：P0-S（安全）→ P0-D（设计锁）→ P0-B1（门外壳）→ **P0-B2a（窄链路激活，先于 P1）** → P1（通用底座）→ P2（蓝图）→ **P2.5（正式迁移，含 B2b 并轨）** → P3。

| 阶段 | 内容 | 工程量 / 门 |
|---|---|---|
| **P0-S 安全与活路径保护** | ① workflow：**新加路由级 runtime flag，先关整条 BPMN task/runtime 路由（含 list，不只关写——list 会泄露流程变量/formData/处理人/单据标识；现 `DISABLE_WORKFLOW` 不停路由）**；designer 若留则独立路由 + 租户授权；**选型前不做完整 BPMN 重构**；安全审计覆盖七面（definitions/deployments/process-start/instance-detail/variables/task-list/history）；② 旧系统：封 `/erp/*`、轮换全部凭据、重置口令、访问排查；③ `assertSheetScope`：立即审计+allowlist（新安装全 strict、新对象必须登记、写先于读切 strict、allowlist 服务器持有绑 tenant/plugin/sheet、跨 tenant/base 未登记立即拒、observe 有截止日），registry 盘点/回填/三态迁移独立估工；④ **`ensureObject` destructive-reconcile 守卫** + after-sales 安装器重入测试 | ≈2–3 pw（仅 BPMN route-gate + ensureObject 守卫等纯工程项）+ **凭据轮换/访问排查=安全运营另计** + **assertSheetScope 迁移=inventory 后估** + 回归=按受影响应用数估（Codex 五轮 §10）；与设计门无关，先做 |
| **P0-D 核心模型 design lock（产出 = ADR + migration 草案 + 最小原型 + 测试/性能/回滚证据，非文档段落）** | principal 生命周期 spike；**writer grants 归一模型 + 合成顺序**；**mirror 发布拓扑 spike（A/B）**；external key registry DDL spike；一 binding 一**逻辑** mirror（物理载体一或多）；source binding 版本模型；三类独立授权；plan 绑 generation/content-key；AppBlueprint 三方 diff + upgrade ledger。**BPMN：仅记录"重新启用条件"，完整授权/租户模型在正式选定 BPMN 后另立项目（#16a′ Deferred）** | 三个 spike + owner/技术负责人分层裁决（§13） |
| **P0-B1 门外备料应用壳** | manifest / 目录 / 权限声明（三态口径）/ app instance + `instanceKey` / 导航；schema-only 蓝图 + 合成 fixture；values-free preflight；plan/confirm/apply **模拟**链路；急停/审计壳；**预置视图替代 `@me`**。验收 = "应用壳与 values-free 平台能力就绪" | ≈4–6 pw；门外 |
| **P0-B2a 窄链路客户激活（先于 P1）** | **只用现有备料专用能力**：具名 PLM/K3 profile + approved config + stock-preparation planner/UoW；单客户单实例；小范围真实只读；owner 门内值面验证；**有限、人工确认的生产 apply**；**不声明通用平台同步能力完成** | 过门后重估（≈3–5 pw 工程 + 门/客户授权日历另计）；门 = 新 issue/operation id + 逐客户 OD-E + 值面（重开 OD-E3/OD-W3-1）+ 生产写（productionPolicy host 映射）三类授权分别过 |
| **P1 通用外部数据底座** | integration principal；binding/version/qualification；**mirror sheet 同步**；**writer grants 接管七条写路径**；external key registry（定案三细则）；同步五阶段状态机（refresh_mirror→publish_generation→propose→approve→apply）；配额/熔断/审计/急停；`data_sources` 加列回填；项目/物料登记表；manualRows 策略、rootSelection preset 目录（门：D2 #4520）；通用 `@me` 算子 | ≈16–24 pw（或显式声明 v1 不支持 rebind/不接管既有 sheet）；门 = writer fence 旗标、S5 重排期、GIP 范围、G0 |
| **P2 蓝图与安全升级** | blueprint schema / `id_map` / `instanceKey`（非末段）/ preflight；**三方 diff、租户修改保留、失败回滚、upgrade ledger**（additive 复用 `ensureMissingObjectFields`）；**CRM-schema**（纯蓝图样板）→ **CRM-sync**（binding 样板）；备料安装描述迁入蓝图 | ≈8–10 pw |
| **P2.5 正式客户迁移（含 B2b 并轨）** | **完整**配置与历史数据导入；正式双轨对账（标注 #4628 只证 source-run 平铺）；切换判据；**旧系统退役**；回滚演练；**B2b：窄链路迁移到通用 binding**；模板演进三项（sortLine/父图号列/material 所有权） | ≈4–6 pw；门 = 客户签字 + 模板冻结门 |
| **P3 第二个真实应用** | 售后或项目管理；之后判断 `masterRef`/聚合收件箱/外部 lookup 是否升平台能力 | ≈6–8 pw；逐客户 OD-E |
| **P4+** | 外部 lookup 产品化（H3-0 后）、双向同步、K3 写回 | 各自门 |

**范围切割（消除 v6 的 B2/P2.5 重复）**：P0-B2a = 小范围真实激活（真实只读 + 沙箱验证 + 有限生产 apply）；P2.5 = 完整配置导入 + 历史迁移 + 正式双轨 + 切换验收 + 旧系统退役。责任与验收口径不再重叠。

**B2a 必须登记为限时架构例外（v8，Codex §11）**——防止窄链路从"首客户交付路径"演变为事实上的第二套集成框架，登记：适用客户 / 适用 PLM/K3 系统 / 允许读写的数据范围 / **禁止被其他应用复用** / owner / **到期时间** / B2b 迁移验收条件 / 逾期未迁移的处理方式。

**规模汇总（Effort=pw 人周；Duration/关键路径/owner 决策最晚时间见 design-lock 稿的日历版；门等待不计入 Effort）**：P0-S ≈2–3 ｜ P0-B1 ≈4–6 ｜ P0-B2a ≈3–5（gate-blocked）｜ P2.5 ≈4–6 → **备料从壳到正式切换 ≈13–20 pw（不含门日历）**；P1 ≈16–24 ｜ P2 ≈8–10 ｜ P3 ≈6–8 → **平台完整态另 ≈30–42 pw**。置信：P0 段中、P1 后低。**每阶段退出标准、并行/串行依赖、calendar week 在正式执行计划补全（Codex §13：Effort/Duration/Dependencies/Owners/Exit Criteria 五段式）。**

---

## 12. 原则（同 v6，第 2 条更新）

2′. 字段可写性真源 = **归一化 writer grants 表**（deny 优先合成顺序），property 只作缓存投影；七条写路径同一策略。
其余：算法 preset 化；外部写显式+默认 OFF+owner 门；一套自动化每动作一条迁移；实例独立 base（备料 staging 布局显式豁免）；考勤不作范式；客户差异落数据；平台能力从应用抽取；否定性结论亲读代码。

---

## 13. Decision Register / 决策登记表（v8：加状态字段）

**层级**：O = owner（安全/授权门）；T = 技术负责人（架构 ADR）；P = 产品；C = 客户签字。**时点**：P0 / P1 前 / 可延 / 非阻塞。**状态（Codex §12）**：Proposed（作者建议）/ Under Review / Ratified（owner 已批）/ Deferred / Rejected / Superseded。**本文所有条目当前状态一律为 Proposed 或 Under Review——"定案一/二/…"字样表示"作者建议锁定值",非 owner 已批准**;进入 design-lock 时逐条改写为 Ratified/Deferred。

| # | 决策 | 层 | 时点 | 状态 |
|---|---|---|---|---|
| 1 | 开新 issue/charter + operation id | O | P0 | Proposed |
| 2 | G0 ratify | O | P1 前 | Proposed |
| 3 | 三类独立授权升格为一等 scope（映射既有门族） | O | P0 | Proposed |
| 4 | 生产角色日常 refresh / autopersist 常开（Plan-B：排期 apply 窗口） | O | P0-B2a 前 | Proposed |
| 5 | 值面：重开 OD-E3/OD-W3-1；H0 平面 B 是否延伸到自登记源；脱敏样例豁免（原问法） | O | P0-B2a 前 | Proposed |
| 6 | S0 输入面纪律是否豁免（向导直接选表/列） | O | P1 前 | Proposed |
| 7 | writer fence 旗标随本线开启 | O | P1 前 | Proposed |
| 8 | 同步表 apply 独立门（不复用 FOS-4b-3-prod） | O | P1 前 | Proposed |
| 9 | GIP-D0 范围 + GIP wiring；S5 重排期 | O | P1 前 | Proposed |
| 10 | 重冻结窗口排期与 S6-B | O | P0-B2a/P1 | Proposed |
| 11 | 逐客户 OD-E1/E2/E6 | O | P0-B2a/P2.5 | Proposed |
| 12 | 主体模型（binding 主体 + assertAccess 用 workspaceId）+ actorId 分叉 | T | P0（P0-D） | Proposed |
| 13 | 作用域轴统一（workspace 为租户轴 vs 补 tenant_id） | T | P0（P0-D） | Proposed |
| 14 | **one mirror sheet = one binding（v7 已建议锁定，待确认）** | T | P0（P0-D） | Proposed |
| 15 | **writer grants 归一模型 + deny 优先合成顺序（v7 已建议锁定）** | T | P0（P0-D） | Proposed |
| 16a | BPMN runtime 关闭(P0-S 立即,route-gate) | O/T | P0 | Proposed |
| 16a′ | 完整 workflow 授权+租户强制+六设计问题——**Deferred 至任务底座正式选定 BPMN 后**,不进当前主线 | T | Deferred | Deferred |
| 16b | **任务底座三选一（a BPMN / b 新建轻量对象【推荐】/ c 审批中心）——不阻塞备料，等派工需求立项** | T+P | 可延（派工立项时） | Proposed |
| 17 | binding 持久化 A（config 语义）/ B（五态） | T | P1 前 | Proposed |
| 18 | `instanceKey` 非末段过渡 → 显式字段长期方案 | T | 可延（P2） | Proposed |
| 19 | `detached` 转 human 评审流程 | T | P1 前 | Proposed |
| 20 | 同步表默认不发 `record.*`（绑定级开） | T | P1 前 | Proposed |
| 21 | 应用实例↔base；备料 staging 布局豁免 | T | 可延（P2） | Proposed |
| 22 | 备料模板冻结门（sortLine/父图号/material 所有权） | T | 可延（P2.5） | Proposed |
| 23 | manualRows / refreshSemantics 设计门 | T+C | P1 前 | Proposed |
| 24 | CRM 拆 schema/sync 两样板；首个样板顺序 | P | 非阻塞 | Proposed |
| 25 | 数据保留/删除/归档/租户导出 + registry 压实 | T | P1 前 | Proposed |
| 26 | 客户可见语义变更签字（批次/审批替换/复用/历史范围/identityMapping） | C | P2.5 前 | Proposed |
| 27 | D2 #4520（图号 profile 载体） | O | P1 前 | Proposed |
| 28 | H3-0 / OD-W3-1 / #4194 排期（外部 lookup） | O | 可延（P4） | Proposed |

---

## 14. 更正记录

**v9 → v9.1（Codex 六轮：双方一致停止 prose 往返；本版仅机械勘误，不加新设计散文）**
- 全文版本号统一 v9.1；删除 §10 / P0-D 残留的 workflow 完整改造（整体 Deferred，#16a′）；彻底删除 `sync_from_source` 旧名（§10 同行矛盾已消）；"one mirror sheet" 改 "一 binding = 一**逻辑** mirror，物理载体一或多"（消与双-sheet 方案的字面冲突）；§15 加 **Production Go-Live Gate**（第 C 层：备份/DR/凭据轮换/SLO/权限 runtime enforcement/审计导出/回滚演练）；registry 加 `registry_generation_id` 与 normalization 升级流程；alias/history v1 二选一显式化。
- **三个模型阻塞项（principal 反向 FK / mirror 发布拓扑 / external key DDL）转 P0-D spike**，产出 ADR + migration + 原型 + 测试，不再靠文档定型；Codex 六轮补的 spike 验收标准落入配套《P0-S 执行 + P0-D spike charter》。
- **rebaseline 已完成（2026-08-20）**：本地 main 快进至 `c5a4a94f7`,Charter 全部 P0-S/spike 驱动事实重核成立;唯一漂移 = workflow 路由行号整体 +1（complete `:530→:531` / claim `:465→:466` / list `:385→:386`,已在 §1 待办行与 Charter 更新）。migration head 已记入前言。

**v8 → v9（Codex 五轮：驳回"分歧清零"过乐观 + 三处正文矛盾 + 三个模型深化）**
- **纠我方过度声明**：撤回"双方分歧清零",改为"上一轮十项均已接受、v8 已基本落入,但正文一致性与三个模型细节待第五轮收敛"。
- **修三处我在 v8 引入的正文矛盾**：① §1 待办行"链条缺失"↔§7"列在但断裂"(改 §1);② §10/§11 残留 `sync_from_source`/`sync→snapshot→plan`(全文改五阶段);③ §4.1 定案二"绑 identity"↔表里 `binding_version_id`(改 `binding_id NULL + constraints_json`)。
- **BPMN 处置去矛盾**：P0-S **只关整条 runtime**;完整授权模型 **Deferred 至选定 BPMN 后**(§7/§1/§13 #16a′ 一致);Decision #16a 拆"关闭(P0)"与"完整改造(Deferred)"。
- **principal 反向 FK**：v8 `automation_principals(kind,subject_id)` 仍多态、只后移一层 → 业务对象反向持 `principal_id FK`,principal 成主体真源(§4.1 定案二)。
- **mirror generation 加物理拓扑**：仅切指针不过滤旧代 → 采内部 staging(方案 A,用户表只含当前代)/双 sheet(B);同表多代(C)侵入读路径不作首选(§4.1 定案五)。
- **Source Mirror 运行时强制**：`sheet_mode/human_write=deny` 可执行策略,非文档纪律;人工信息走独立 Local Enrichment Sheet(§4.1 定案六)。
- **external key DDL 补全**(NOT NULL/normalization_version/长度/事务边界)(§4.1 定案三);**同步五阶段全文统一**(§4.1 定案四)。
- **B2a 例外边界、P0-S 拆估(安全运营另计)、§15 分三层、"代码零复用"改"选择性复用/翻译"、基线记 `c5a4a94f7`**。
- 状态降为 **Ready for Ratification Review — Not Yet Design-Locked**。**三个 design-lock 阻塞项(BPMN 处置已定/principal 生命周期/mirror 存储拓扑)转为 P0-D 设计 spike,不宜再靠 prose 迭代解决。**

**v7 → v8（Codex 四轮深审）**
- **纠我的错 1（BPMN 先关整条路由）**：v7 写"先关写、留 list"不够——list 泄露流程变量/formData/处理人/单据标识；且 `DISABLE_WORKFLOW=true` 只跳过 `initialize()`、不停路由（亲验 `workflow.ts:30`、`index.ts:1458`）→ 需**新加路由级 runtime flag,先关整条 task/runtime 路由(含 list)**;选型前不做完整 BPMN 重构。§7/§11。
- **纠我的错 2（BPMN 租户模型代码事实）**：v7 说"归属链缺失"过绝对——`bpmn_process_definitions/instances` **已有 `tenant_id` 列**(亲验 `zz20251231…:19,57`);准确说法是"列在、传递/过滤/强制断裂"(`getLatestVersion`/`getProcessDefinition` 收 tenantId 不过滤;deploy 漏写)。审计范围扩到七面。§7。
- **纠 bug（external key 唯一约束矛盾）**：`UNIQUE(binding_id,hash) WHERE active` + "命中比 canonical" 自相矛盾 → 采方案 B `UNIQUE(binding_id,hash,canonical_key)` + `UNIQUE(binding_id,record_id) WHERE active`。§4.1 定案三。
- **writer 统一 principal**：`writer_kind+writer_id` 多态外键 DB 无法强制 → 加 `automation_principals` 表,grant 引 `writer_principal_id`;grant 绑 binding identity(升级不丢授权)。§4.1 定案二。
- **同步动作拆三命令**：`refresh_mirror_from_source` / `propose_business_apply` / `apply_plan`。§4.1 定案四。
- **mirror generation 原子发布**：`active_generation_id` + 原子切换,消除新旧两代混合。§4.1 定案五。
- **Source Mirror / Curated Master 分类**：判据 = "表里是否有必须永久保留的人工信息"。§4.1 定案六。
- **B2a 限时架构例外登记**（适用客户/系统/范围/禁复用/owner/到期/迁移验收/逾期处理）。§11。
- **Decision Register + 状态字段**（Proposed/Under Review/Ratified/Deferred/Rejected/Superseded);澄清"定案 X"= 作者建议锁定值、非 owner 已批。§13。
- **估算补五段式**(Effort/Duration/Dependencies/Owners/Exit Criteria)+ 基线记全 SHA/migration head。§11/前言。
- 状态升为 **Design Lock Candidate — Conditional Approval**。

**v6 → v7（Codex 三轮深审：零代码事实异议；六项 design-lock 前修正全部落掉）**
1. **P0-B2 拆 a/b**：B2a 用现有备料窄链路（具名 profile + approved config + planner/UoW，单客户，不宣称通用能力）**先于 P1**；B2b（迁通用 binding）依赖 P1、并入 P2.5——消除 v6 的依赖冲突。
2. **消除 B2/P2.5 范围重复**：B2a = 小范围真实激活；P2.5 = 完整迁移/正式双轨/切换/退役。
3. **workflow 补租户归属模型**：授权函数必须建立在 task→实例→定义/app→tenant 链上；list 需安全投影；六个设计问题进 P0-D。
4. **v1 锁定 one mirror sheet = one binding**：业务主表只经 plan/apply；同步只写 mirror；替换 v5/v6 的"业务表标 syncing + allowed-stale"方案。**旁证：这正是备料线现行架构（MVP snapshot = mirror，canonical apply = plan 边界）——Codex 第三次独立重推出现有线的形状。**
5. **writer grants 归一化**：`meta_field_writer_grants` 为安全真源、property 只作缓存；deny 优先合成顺序锁定。
6. **单位统一（pw/cw + 团队假设 + 门另计）**；**28 个决策分四层（O/T/P/C）× 四时点**，不再全部串行压在 owner 上。
另：`@me` 移出 P0-B1 阻塞；CRM 拆 CRM-schema/CRM-sync；`ensureObject` destructive-reconcile 守卫提前到 P0-S；`assertSheetScope` 过渡期从"只告警"升级为带七条硬约束的过渡（新装全 strict、写先于读、allowlist 服务器持有、observe 截止日）；manifest permissions 三态验收口径；registry 补"hash 定位 + canonical 比对 + alias/history 表"。

**v5 → v6 / v4 → v5 / 更早**：见前版记录（三类授权与门族映射、workflow 四处、legacy 容忍、ensureObject 隐患、三动作 revision、field_permissions 既有轴、additive 原语、117 函数、@me 不存在、跨 base link、binding 归一化、registry、value_origin+allow_set、detached 归 binding 等）。

---

## 15. 尚未设计（v9 分三层，Codex 五轮 §11）

**A. Design-Lock 阻塞项（必须 Ratify 才进 P1）**：principal 生命周期与引用完整性（§4.1 定案二）；writer grant identity/version；**mirror 存储与发布拓扑（§4.1 定案五 A/B 选型）**；external key DDL + **registry_generation_id**（§4.1 定案三；normalization 升级=冻旧代→重建→检坍缩→迁移报告→原子切换→plan 变 stale）；plan 一致性（content-key + generation 绑定）；租户与字段权限合成；B2a 例外边界。**alias/history 二选一：v1 支持源端重编号则其 schema+运行时进 P1;否则 v1 显式拒绝自动重编号、只许人工迁移（Codex 六轮 §6）。**
**B. 执行包必须补（进 P1 前）**：可执行测试矩阵（写者×归属合同、跨作用域拒绝、回收站×registry、键归一非坍缩、规模基准、蓝图安装/升级幂等回滚、备料 plan byte-parity、after-sales 重入+租户修改保留）；migration；rollback；observability（键碰撞率/held 积压/registry 漂移/tombstone 复活）；容量基准；每阶段 Exit Criteria。
**C. Production Go-Live Gate（不阻塞 design-lock,但阻塞生产上线,Codex 六轮 §7）**：备份恢复演练；数据保留与租户删除；凭据轮换;SLO 与告警;灾难恢复;**App Center 权限 runtime enforcement（在此落地前不得对客户宣称"应用已实现权限隔离"）**;审计导出;生产回滚演练。
**D. 后续产品功能（不阻塞）**：页面编排；移动端；聚合收件箱；external lookup；更完整导出体验；BindingQualification GIP 四语义；identityMapping 替代。

## 16. 配套文档与取代关系
- 评估一 / 评估二 / 设计稿三：链接同前（https://claude.ai/code/artifact/2bfcbaea… / d8def3b2… / c75b2488…）。设计稿三被取代部分见 v6 §16；**v7 另取代其"业务表直接同步"的运行语义（改为 mirror 模型）**。
