# 考勤 vNext：钉钉对标、易用性提升与前端收敛开发总纲 — 2026-07-20

> **Status: RATIFIED（owner accepted OD-VX1..OD-VX6 on 2026-07-20）**
>
> 本文是考勤 vNext 体验线的单一开发总纲，用于约束信息架构、实现顺序、组件拆分、测试门禁、
> 模型分工与收口口径。owner 已接受本文 §12 的全部推荐裁决；该裁决立即授权按顺序推进 Wave 0
> 与 Wave 1，不等于一次性授权后续所有 runtime。Wave 2 及以后仍必须满足各波硬前置、独立设计锁
> 和逐片审阅门禁。
>
> **不得用本文重开已归档的 attendance v1 或 S7。** v1 staging acceptance、DingTalk E1-E4、
> S7-0..S7-5 均是已交付基线；vNext 只改“用户如何找到、理解和完成工作”，除非另有独立
> design-lock 明确授权行为或后端语义变化。

## 0. 一句话结论

Metasheet2 考勤在规则、排班、审批、通知、报表和审计能力上已经具备对标钉钉的基础，并在
可解释、可审计、预览/回滚和复杂排班治理上存在局部超越机会；当前主要短板不是缺少规则，
而是首次配置、任务导航、移动端信息优先级和页面一致性。

vNext 的正确目标不是复制钉钉皮肤，而是吸收其“按任务进入、模板先行、渐进展开、结果有反馈”
的产品逻辑，再把本系统已有的规则透明度做成用户可感知的优势。

## 1. 权威基线与证据边界

### 1.1 仓库基线

- 本文刷新基线 `origin/main`: `86838c11f314c950ac32c394deabd37f8cd19990`
  (`feat(approval): FWB-3 — decision-value freeze + node-scoped writeback executor (#4344)`)。
- S7 交付锚点 `a98996ee2e0269b22801a6b87d2b8d5b5f076025`
  (`docs(attendance): verify S7 dynamic approver delivery (#4483)`) 已确认是该基线祖先；后续主线提交未重开
  S7 业务范围。
- attendance v1：五窗口 staging acceptance 与 DingTalk E1-E4 已闭环；不得因 UI 改造重跑或改写其业务结论。
- S7：`direct_manager`、`dept_head`、`manager_at_level` 已完成代码与验证；
  `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED` 仍默认 OFF，启用属于 operator/owner opt-in，
  不是本体验线的默认动作。
- `apps/web/src/views/AttendanceView.vue` 当前约 31,445 行：template 约 9,917 行、script 约
  18,536 行、style 约 2,992 行。
- `apps/web/src/views/attendance/` 已有 56 个组件、composable 与纯模块，但 overview/reports/admin
  的主要 DOM、状态和大量写入接线仍集中在 `AttendanceView.vue`。

### 1.2 钉钉对标证据

本文的钉钉页面判断基于 owner 提供的阿里文档管理员手册离线包，下载时间
`2026-05-27T09:25:54.972Z`。手册考勤目录包含 14 个一级能力块，并进一步展开为考勤组、
班次、排班、自动对班、规则、统计、假期、管理员、通知、多时区、申请入口和多种打卡方式。

这是产品设计基准，不是对钉钉所有当前版本、付费档位、原生端或硬件能力的无限承诺。
凡本文没有在手册或当前仓库中核实的能力，不得写成“已对标”或“已超越”。

### 1.3 现有 UI 资产，禁止重复建设

| 资产 | 当前状态（2026-07-20） | 本总纲处置 |
|---|---|---|
| #4371 focused admin rail guard | OPEN / BEHIND，head `1a88e7aa5`；历史 required checks 绿 | 先刷新、复核并合入，作为后续 admin 改造测试前置 |
| #4359 group setup workflow | OPEN / BEHIND，head `2eff10bc9`；历史 required checks 绿 | 保留四阶段列表-详情实现，禁止另造第二套考勤组编辑器 |
| #4370 employee overview lock | OPEN / draft / PROPOSED / BEHIND，head `6a01ec630` | 作为员工 task-first 权威设计输入；owner ratify 后才实现 |
| #4414 admin task home | OPEN / stacked draft / CLEAN，head `8a10cdea5`，base=`codex/issue-4354-attendance-group-workspace` | 只保存实现意图；当前仅 stacked-base 检查绿，不等同 main required gate；在 issue #4355 runtime 后从新 main 重新移植并全量 re-gate |

编号图例：#4353（管理中心）、#4354（考勤组）、#4355（员工总览）是需求 issue；#4359 是
考勤组 runtime PR，#4370 是员工总览 design-lock PR，#4414 是管理中心旧 stacked runtime draft。
员工总览 runtime PR 尚未创建；管理中心最终 re-port 也可能使用新的 PR，不能把需求 issue 写成可合并对象。

上述状态在 `2026-07-20` 通过 GitHub 实时读取；`BEHIND` 分支不得仅做 update-branch 后直接合并，必须先证明
旧 patch 没有覆盖主线新增行为。任何后续状态变化仍以 GitHub/main 为准。

产品落地顺序是：#4359（issue #4354）-> issue #4355 的 post-#4370 runtime PR ->
issue #4353 的 #4414 re-port PR。`AttendanceView.vue` 是单一热文件车道，不得让这三条 runtime
并行修改同一模板。#4371 是独立 test/workflow 前置，可先落。

## 2. 对标结论与产品边界

### 2.1 能力矩阵

| 领域 | Metasheet2 当前基线 | 钉钉手册呈现 | vNext 判定 |
|---|---|---|---|
| 考勤组、班次、固定/排班/自由工时 | 已有组、班次、轮班、固定排班和有效日历 | 路径清楚、模板化强 | 能力可对标，主要补交互路径 |
| 高级排班 | 多班次、草稿/发布、临时班次、自动对班、换班、调度均已闭环 | 自动对班与排班操作成熟 | 治理与可追溯性可局部超越 |
| 假期、加班、调休 | 计提、余额、有效期、批量调整、加班分段和 bank 已有；计提与 overtime bank 依赖显式 policy/scheduler opt-in，默认不执行 | 配置入口成熟、场景文案充分 | 能力强，补场景化说明与结果解释 |
| 审批 | A1 结构化编辑器 + S7 三类动态审批人；S7 默认 OFF | 与钉钉审批生态天然一体 | 能力接近，体验和启用路径仍弱 |
| 报表、导入、审计 | CSV/XLSX、字段选择、识别回显、同步、审计与分级报表已在 | 报表模板、移动统计、导出路径清楚 | 数据能力强，产品化与移动入口需补 |
| 通知 | DingTalk/WeCom、outbox、重试和状态观测已在 | 默认通知链路更自然 | 可靠性可对标，配置易用性落后 |
| 首次配置与管理导航 | 功能齐但页面密、概念多 | 按管理员任务逐层展开 | 明显落后，本轮主战场 |
| 移动打卡和硬件生态 | H5/微应用、地点与照片证据；无原生硬件全栈 | Wi-Fi、蓝牙、考勤机、人脸与原生体验强 | 不宣称整体超越，保持 OUT/按需集成 |

### 2.2 允许的对外结论

可以表述：

- “面向中小企业的规则驱动考勤治理，核心能力可对标钉钉。”
- “在规则透明、审计证据、预览/回滚和复杂排班治理上具备差异化优势。”

不得表述：

- “Metasheet2 考勤已经全面超越钉钉或飞书。”
- “已具备钉钉同等的原生定位、防作弊、人脸、蓝牙、Wi-Fi 或考勤机生态。”
- “已提供原生算薪闭环。”本系统可以提供薪资输入、周期与报表，但不能把集成面写成原生薪酬系统。

### 2.3 从钉钉吸收什么，不吸收什么

应吸收：

1. 按任务而不是按数据表或后端资源组织入口。
2. 先选适用场景或模板，再进入具体字段。
3. 列表保留上下文，详情或抽屉完成编辑。
4. 低频规则渐进展开，保存后明确显示状态和下一步。
5. 桌面与移动端围绕不同主任务排序，而不是简单缩放同一长页面。
6. 每项复杂设置都说明适用场景、影响对象与常见失败原因。

不应照搬：

1. 超长左侧导航和所有功能同时可见的密集后台。
2. 宽表格依赖水平滚动的报表布局。
3. 仅用“设置”文本链接区分不同层级操作。
4. 把帮助文档当成产品流程的替代品。
5. 为了视觉相似而放弃现有 UF token、可访问性和移动端验收标准。

## 3. 用户角色与必须完成的核心任务

### 3.1 员工

首屏必须回答三个问题：

1. 我今天是否需要打卡，当前是什么状态？
2. 我现在唯一最该做的动作是什么？
3. 如果状态异常，为什么异常、去哪里补救？

核心任务：上班/下班打卡、查看今日时间线、处理缺卡或异常、提交请假/加班/外勤/换班请求、
查看最新申请与近期记录。

### 3.2 直属主管或部门负责人

核心任务：查看团队今日状态、处理待审批事项、定位异常人员、查看规则依据；不得暴露超出其
组织/assignment/scheduler scope 的数据或管理动作。

### 3.3 HR/考勤管理员

首屏不得要求管理员理解全部内部对象。核心任务按以下四组呈现：

1. 日常运营：审批、异常、导入、通知、审计跟进。
2. 人员与考勤组：考勤组、成员、负责人、团队可用性。
3. 工时与规则：班次、排班、假期、规则集、加班与请假政策。
4. 报表与薪资准备：报表、字段、周期、模板和导出。

### 3.4 实施与运维人员

核心任务：判断组织是否已准备好启用、查看 values-free readiness、执行受控 smoke、核对通知
和同步状态。实施入口不得与员工日常页面混在同一首屏。

## 4. 目标信息架构

### 4.1 员工总览

DOM 与视觉顺序固定为：

1. **Today**：今日状态、打卡主动作、两节点时间线。
2. **Needs attention**：只显示一个最高优先级事项和一个真实可用的主动作。
3. **Requests and quick actions**：申请状态、补卡/请假/加班/换班快捷入口。
4. **More attendance tools**：余额、规则、历史筛选、日历、记录和低频说明。

优先级必须复用 #4370 的 first-match 规则。未知状态不得映射为 all-clear；错误 message/code/hint
和真实 retry 动作不得被折叠到历史筛选中。

### 4.2 管理首页

默认显示 task home，不同时展示完整配置长页。每个任务入口包含：

- 名称与一句结果导向说明。
- readiness/status：未配置、需处理、正常、失败。
- 主动作：进入唯一详细区块。
- 可选次动作：查看说明或历史，不产生重复写路径。

进入具体任务后，右侧只渲染一个 active section；保留现有 anchor/query/hash deep-link，提供明确
“返回管理首页”。最近访问和快速跳转属于辅助导航，不得与 task home 争抢首屏主层级。

### 4.3 考勤组工作区

以 #4359 为唯一实现基础：

1. 基本信息。
2. 考勤人员。
3. 工作时间。
4. 规则政策。

桌面端为列表-详情；移动端先列表后详情。列表行必须在不打开详情时显示成员数、班制与规则摘要。
未保存的新组进入工作时间前必须有 save-first 提示，禁止出现空白或不可解释的面板。

破坏性操作与主要配置动作分离。不得在本波新增 group-owned punch-policy 后端语义；若确有需求，
另起 API/schema design-lock。

### 4.4 报表与审计

报表入口先提供常用模板：每日、月度、年度、异常、打卡原始记录，再进入自定义字段选择。
宽表在桌面端允许受控横向滚动，但首屏摘要与关键列不得依赖横向滚动；移动端先显示摘要和异常，
导出与完整字段选择进入后续步骤。

审计信息以“发生了什么、谁操作、依据什么、如何恢复”组织，不按内部 event code 直接堆给业务用户。

### 4.5 首次启用向导

首次启用向导只编排已有能力，v1 不新增后端规则引擎：

1. 同步或创建组织人员。
2. 创建考勤组并选择人员。
3. 选择班制与班次模板。
4. 配置允许的打卡方式。
5. 关联审批流程。
6. 配置通知渠道与接收范围。
7. 预览影响范围并启用。

每一步必须显示：完成状态、缺失项、影响人数、计划生效时间、预览入口和修复动作。
向导不能替用户静默开启 feature flag、通知真实外部人员或修改生产配置。

推荐提供四个无副作用起步模板：办公室固定班、门店排班、工厂多班次、销售/外勤。
模板只预填，不立即写入；最终写入继续走现有 preview/confirm/save 路径。

### 4.6 上下文帮助

帮助内容按当前任务显示，不复制整本外部手册：

- “适用于什么场景”。
- “保存后影响谁、何时生效”。
- “常见失败与如何恢复”。
- “查看计算依据/审计记录”。

所有帮助必须 values-free，不包含客户标识、真实用户、token、主机、内部日志路径或环境秘密。

## 5. 不跑偏的产品与工程红线

1. **不重开业务语义**：UI PR 不改考勤计算、审批、排班冲突、通知、余额、权限或数据库语义。
2. **一个动作一个写路径**：重排和抽组件不得复制 punch/request/import/save/delete 调用。
3. **权限不前移到前端**：前端隐藏只是体验；服务端 RBAC、org scope、assignment 和 scheduler scope 保持权威。
4. **未知状态 fail-closed**：不得把未知/加载失败/缺配置显示为成功、正常或 all-clear。
5. **保留兼容合同**：现有 `data-*`、`data-testid`、section id、query/hash deep-link、payload 与错误映射保持。
6. **无静默截断**：人数、日期、字段或批量上限必须阻断并解释，不得截到上限后假成功。
7. **不造第二套表单**：快捷入口只预填并跳转到 canonical form，不复制隐藏表单。
8. **不以帮助代替产品**：需要反复查手册才能完成的主任务视为 UX 缺陷。
9. **不扩张 OUT**：原生硬件、人脸、防作弊、Wi-Fi/蓝牙、原生算薪、飞书和多午夜不借 UI 波次混入。
10. **不并行碰热文件**：任何时刻只允许一条 runtime PR 修改 `AttendanceView.vue`。
11. **不以截图代替测试**：截图证明布局，DOM/状态/网络断言证明行为。
12. **不以历史 PR body 当现状**：每波开工前重新读取 `origin/main`、PR head、checks 与 merged verification。

## 6. `AttendanceView.vue` 收敛策略

### 6.1 原则

不做一次性重写。每个产品波次顺带抽取一个稳定边界，先拆展示和纯状态，再拆网络与写入；
每次拆分必须有 patch-level 行为等价证明。

新组件不得：

- 自行 fetch 已由父层加载的数据。
- 自行读取新的权限真源。
- 改写请求 payload 或错误码。
- 复制父层的 watcher、route sync 或状态恢复逻辑。
- 通过隐藏旧 DOM 保留兼容，导致两套表单同时挂载。

### 6.2 建议组件边界

| 波次 | 抽取目标 | 首版职责 | 暂留父层 |
|---|---|---|---|
| Wave 1 / issue #4354 | `AttendanceGroupWorkspace.vue` | 列表-详情、四阶段导航、响应式布局 | group/member/owner/save/delete handler |
| Wave 2 / issue #4355 | `AttendanceEmployeeWorkspace.vue` | Today/attention/tools 布局、展示 props、emit 真实动作 | API、route sync、punch/request handler |
| Wave 3 / issue #4353 | `AttendanceAdminTaskHome.vue` | 四任务组、status、入口与返回首页 | section 权限过滤、active id、数据加载 |
| onboarding | `AttendanceSetupReadiness.vue` | 七步状态、缺口与导航 | readiness API 聚合、实际保存/启用 |
| explainability | `AttendanceDecisionTrace.vue` | 规则依据与审计时间线展示 | 权威数据加载与字段脱敏 |

纯逻辑优先落到独立 `.ts`：attention priority、readiness state、task grouping、decision-trace mapping。
纯模块必须有完整判别矩阵，不允许再把分支埋回 Vue template。

### 6.3 收敛棘轮

- 本总纲 ratify 后，`AttendanceView.vue` 不再接受与当波无关的新功能块。
- 每个 runtime 波次应证明该文件净新增没有形成新的长期业务域；若因移植暂时净增，verification MD
  必须说明下一抽取点和债务上限。
- 第一阶段目标不是任意行数归零，而是让员工、管理首页、考勤组三个高频域拥有独立组件合同。
- 中期目标：`AttendanceView.vue` 只负责 mode/route、共享加载状态、错误出口和子域组合；业务域模板与
  纯状态选择器全部外移。

## 7. 开发波次与严格顺序

### Wave 0：护栏刷新

交付：

- 从最新 main 刷新 #4371，核对 focused-mode 现状，保留真正会因行为回退而变红的 assertion。
- required attendance web guard 必须真实运行该 spec，run-list 与 push/pull_request path filter 同时接线。

完成门：current-head required checks fresh-green、up-to-date、mutation 能杀死 focused-mode 回退。

模型：Grok 或 Sonnet 做机械刷新；Codex 独立复核 workflow 真接线和 mutation。

### Wave 1：考勤组四阶段工作区

交付：

- 从最新 main 重放 #4359 的最小业务 patch，先做 range-diff/patch-id 核对，避免旧分支覆盖 main 新增逻辑。
- 保留 group/member/owner/rule/fixed-schedule API、selector 与 deep-link。
- 完成 1440x900、1024x768、390x844 三视口验证。

完成门：保存前状态、四阶段导航、列表摘要、移动端顺序和破坏性动作均有 mounted 测试；
无横向页面滚动；current-head required checks fresh-green。

模型：Grok 做 re-port 和测试；Kimi K3 做三视口视觉检查；Codex 做语义与兼容复核。

### Wave 2：员工 task-first 总览

硬前置：#4359 已合；owner ratify #4370 的 OD-O1..OD-O4。

推荐裁决：接受 #4370 的 first-match attention priority、历史筛选默认折叠、请求/快捷动作先于余额/规则、
无 feature flag 的直接前端重排。

交付：

- Today -> Needs attention -> More tools 三带布局。
- 独立 `attendanceOverviewPriority.ts` 或等价纯模块。
- `AttendanceEmployeeWorkspace.vue` 首次抽取。
- 保留 punch error、note、retry、request deep-link 与 employee-only 权限边界。

完成门：normal、late/early、missing punch、pending/rejected request、punch error、no-data、unknown
至少七态矩阵；一个且仅一个 primary action；三视口无重叠和横向滚动；两刀 mutation 独立变红。

模型：Kimi K3 先出基于现有 DOM 的桌面/移动 mock；Grok 实现与跑测试；Codex 对抗复核状态优先级、
网络调用次数、权限和 selector 兼容。

### Wave 3：管理中心 task home

硬前置：Wave 2 已合。不要直接合当前 stacked #4414；先从 post-Wave-2 main 重新移植其业务意图。

交付：

- 四任务组首屏。
- 只显示一个 active admin section。
- 返回管理首页、最近访问、快速跳转与全部旧 deep-link 兼容。
- `AttendanceAdminTaskHome.vue` 首次抽取。

完成门：所有任务入口唯一落到 canonical section；admin forbidden、delegated admin、direct deep-link、
org bucket change 均有 mounted 测试；移动端不显示竞争性的长配置列表。

模型：Grok 做 re-port；Kimi K3 审视层级和移动导航；Codex 复核 RBAC 与 route compatibility。

### Wave 4：首次启用向导

硬前置：另起 docs-only design-lock，先完成现有 API/readiness 侦察；不得假设七步都已有统一状态端点。

首版允许：

- 只读汇总已有设置与 values-free readiness。
- 通过 deep-link 进入现有 canonical form。
- 提供无副作用模板预填与 preview。

首版禁止：

- 一键跨资源提交。
- 自动开启 S7、通知 worker、真实外发或生产 feature flag。
- 创建新的“万能保存”后端端点。

完成门：全新 synthetic org 在不手输 JSON/内部 ID 的条件下，可以按七步到达 preview-ready；
中途退出后状态可恢复；缺配置与权限不足明确区分。

模型：Codex 做 API/权限侦察与设计锁；Kimi K3 做向导层级；Grok 实现纯前端聚合与测试。

### Wave 5：结果解释与上下文帮助

交付顺序：先只读决策轨迹，再上下文帮助；任何缺少权威 provenance 的结果不得由前端猜规则原因。

首批覆盖：今日状态、迟到/早退、缺卡、加班分段、调休余额、审批人来源。

完成门：每类解释都能指向真实来源、版本/生效日和操作记录；没有数据时显示“无法确定依据”，
不生成貌似合理的解释。

模型：Codex 设计数据合同和 fail-closed mapping；Grok 实现；Kimi K3 校正文案和信息层级。

## 8. 测试与验收总门

### 8.1 每个 runtime PR 必须通过

1. 受影响纯模块 spec。
2. 真实挂载的 attendance self-service/admin regression spec。
3. `attendance-web-guard` current-head required check。
4. 本波新增或重命名的 spec 必须同时加入 `attendance-web-guard` 的实际 Vitest run-list，以及
   `pull_request`、`push` 两套 path filter；current-head CI 日志必须证明该 spec 被收集并执行，
   且承重 mutation 在同一条 targeted command 下使它变红。只有 workflow 状态绿不算完成。
5. `pnpm --filter @metasheet/web exec vue-tsc -b`。
6. `pnpm --filter @metasheet/web build`。
7. 至少两刀针对承重分支的 mutation；必须记录变异、红测试和还原后结果。
8. 1440x900、1024x768、390x844 浏览器验证与截图。
9. `document.documentElement.scrollWidth <= document.documentElement.clientWidth`。
10. 关键元素非零尺寸、无重叠、长中文/英文可换行、按钮文案不溢出。
11. existing selector/deep-link/API call-count compatibility 回归。

测试使用 synthetic fixture。不得在 UI PR 中连接客户数据、真实通知或生产环境。

### 8.2 必测角色

- 普通员工。
- 有 active assignment 的审批人。
- 委派考勤管理员。
- 平台管理员。
- 无权限成员。

前端隐藏和服务端拒绝分别验证；不得用一个 admin happy path 代表全部角色。

### 8.3 必测状态

- 正常、异常、无数据、加载中、加载失败。
- 空配置、部分配置、完整配置。
- 直接 deep-link、页面刷新、org 切换、窄屏切换。
- action 成功、业务拒绝、权限拒绝、网络失败和 stale response。

### 8.4 视觉证据不是装饰

每个 UI verification MD 必须列出：viewport、测试角色、页面状态、截图文件、overflow/overlap 断言、
键盘焦点/ARIA 结果。只提供一张正常态桌面截图不得判定 UI 完成。

## 9. 易用性完成指标

这些指标先在 synthetic staging 或本地受控环境验证，不要求客户接受七天真实运行：

| 指标 | 目标 |
|---|---|
| 新 HR 完成基础启用 | 20 分钟内到达 preview-ready，不输入 JSON 或内部 ID |
| 员工完成打卡或异常补救 | 从总览起不超过 3 个主要动作 |
| 首屏决策 | 390x844 与 1440x900 均能看到今日状态与唯一下一步 |
| 高频管理入口 | 考勤组、班次、假期、规则、审批、异常、导入在管理首页一跳可达 |
| 错误可恢复 | 每个阻断错误提供原因、保持用户输入并给出真实下一步 |
| 页面稳定性 | 三视口零页面级横向滚动、零关键控件重叠 |
| 解释完整性 | 已覆盖状态全部来自权威字段/审计，不由前端猜测 |

不得用“用户感觉更好”作为唯一验收。每项必须落为 DOM、状态、路径长度或受控任务完成证据。

## 10. 模型分工与交付责任

### Kimi K3

适用：阅读钉钉截图、桌面/移动信息层级、中文 copy、mock、responsive visual review。

不得独立裁决：权限、API 语义、数据来源、fail-closed、feature flag 或是否可合。

### Grok Build

适用：组件抽取、机械 re-port、纯函数、挂载测试、workflow 接线、类型检查和 build。

交付要求：必须在独立 worktree；提交变更清单、测试命令、mutation 红证据和未解决项。Grok 自报 green
只是实现证据，不是最终 reviewer verdict。

### Codex

负责：基线核对、边界、顺序、权限/状态语义、对抗复核、main diff、CI wiring、视觉验收与最终 go/no-go。

### Owner

负责：ratify 产品决策、授权行为变化与 operator opt-in、最终接受对外口径。模型或自动化不得代替 owner
翻转 `PROPOSED -> RATIFIED`。

## 11. 防漂移变更控制

### 11.1 开工前检查

每个切片必须在 PR body 或 design-lock 记录：

- 当前 `origin/main` SHA。
- 相关 open/merged PR 与 issue 查重结果。
- 本切片修改文件和碰撞车道。
- 明确 IN/OUT。
- 权威数据源、唯一写路径和权限真源。
- 完成门与 mutation 目标。

缺任何一项不得开 runtime。

### 11.2 变更分类

- display/IA-only：可在本总纲 ratify 后按波次实施。
- API/payload/schema/RBAC/计算语义变化：必须新建独立 design-lock，不得作为“顺手修复”混入 UI PR。
- 安全或数据正确性缺陷：立即停 UI 扩面，独立修复、独立审阅、回主线后再续 UI。
- 新原生/硬件/外部系统能力：进入 OUT/gated 台账，不因竞品存在而自动立项。

### 11.3 PR 与验证记录

- 每个 runtime PR 单一目的，禁止同时做视觉改造、后端语义和大规模清理。
- 每波实现后新增 verification MD，记录 merged SHA、测试、mutation、视觉状态、findings 与 deferred。
- 只更新本总纲的“已交付台账”，不复制第二份平行路线图。
- PR body、issue 与 MD 的状态必须区分：设计完成、代码完成、CI 通过、merged、staging-proven、operator-enabled。

### 11.4 停止条件

出现以下任一情况立即停止并上报：

- 需要改变业务语义才能完成视觉目标。
- 现有 PR 与 main 发生不可证明的语义漂移。
- 新组件需要复制写路径或绕过父层权限/错误处理。
- required spec 未真正接入 workflow。
- 视觉方案在 390x844 依赖隐藏核心功能。
- 需要客户数据、真实通知、生产配置或 operator credential 才能继续。

## 12. Owner 决策菜单

owner 已采用以下推荐值：

| 决策 | 已裁决内容 | 影响 |
|---|---|---|
| OD-VX1 顺序 | Wave 0 #4371 -> Wave 1 #4359（issue #4354）-> Wave 2 issue #4355 runtime -> Wave 3 issue #4353/#4414 re-port -> onboarding -> explainability | 保持单热文件串行，先员工后管理首页 |
| OD-VX2 员工总览 | 接受 #4370 OD-O1..OD-O4 推荐项 | 批准 Wave 2 产品方向；runtime 仍 gated 于 #4359 合入与 #4370 状态同步，无 feature flag 双模板 |
| OD-VX3 首次模板 | 办公室、门店、工厂、销售/外勤四模板，只预填不提交 | 解锁 onboarding design-lock |
| OD-VX4 帮助策略 | 页面内上下文帮助，不复制完整钉钉手册 | 减少维护漂移与版权风险 |
| OD-VX5 组件收敛 | 随产品波次渐进拆分，不单开大重写 | 控制 `AttendanceView.vue` 风险 |
| OD-VX6 对标边界 | 只宣称核心治理可对标、局部可超越；原生/硬件保持 OUT | 防止路线和市场口径过度扩张 |

**Owner decision record（2026-07-20）**：`OD-VX1..6 = ACCEPT RECOMMENDED`。

该记录授权总纲顺序与边界，并立即解锁 Wave 0/1。OD-VX2 同时接受 #4370 的 OD-O1..OD-O4
产品方向，但 #4370 文档仍需在 #4359 合入后刷新到新 main 并完成自身 `PROPOSED -> RATIFIED`
状态同步，才可开启 Wave 2 runtime。

## 13. Definition of Done

本 vNext 体验线只有同时满足以下条件才可收口：

1. 本总纲 `RATIFIED`，所有 OD 有记录。
2. #4371 与 #4359 已合入并 fresh-green；#4370 已从 post-#4359 main 刷新、RATIFIED 并合入；
   issue #4355 的 runtime PR 与 issue #4353 的 post-Wave-2 #4414 re-port PR 均按顺序合入并 fresh-green。
3. 首次启用向导完成独立 design-lock、实现和验证，不自动改 operator flag。
4. 员工、主管、HR 三角色的高频任务均达到 §9 指标。
5. 三视口视觉与 DOM/状态证据完整。
6. 三个高频域已从 `AttendanceView.vue` 建立独立组件合同，且没有第二写路径。
7. 每波 verification MD 在 main，台账区分 merged、staging 与 operator-enabled。
8. 对标矩阵重新核对，不把 OUT、默认 OFF 或未部署能力写成已交付。
9. owner 最终复核通过后，才允许宣告“考勤 vNext 易用性收口”。

## 14. Ratify 后的第一个执行批次

1. 只读刷新 #4371 与 #4359 到最新 main，输出 range-diff 和 stale-test 结论。
2. #4371 current-head gate 通过后先合。
3. #4359 完成 re-port、三视口和对抗复核后合。
4. 复核 #4370 与 post-#4359 main；若无语义漂移，按 OD-VX2 为 issue #4355 新开 runtime PR。
5. issue #4355 的 runtime 合入后再 reclaim #4414 的业务意图，禁止直接合旧 stacked head。

在上述五步完成前，不开 onboarding runtime、不追加新的 `AttendanceView.vue` 功能块、不启动原生/硬件
或飞书线。

## 15. 权威交付台账

> 本表只记录事实状态。`designed`、`code-green`、`merged`、`staging-proven`、`operator-enabled`
> 不得合并成一个“完成”。每次相关 PR 合入后，在 verification MD 落地的同一批次更新本表；
> 若表内状态与 GitHub/main 冲突，以实时 GitHub/main 为准并立即修正文档。

| 波次/资产 | 设计 | Runtime | 验证 | 当前权威状态 |
|---|---|---|---|---|
| 本总纲 | 本文 | N/A | `git diff --check` + 引用核对 | RATIFIED；OD-VX1..6 于 2026-07-20 接受推荐值 |
| Wave 0 / #4371 | 既有测试意图 | test/workflow only，head `1a88e7aa5` | 历史 checks 绿，需 current-head 重跑 | OPEN / BEHIND |
| Wave 1 / #4359 | issue #4354 | 已有实现分支，head `2eff10bc9` | 历史 required checks 绿，需 re-port 后重跑 | OPEN / BEHIND |
| Wave 2 / issue #4355 | #4370 **RATIFIED**（owner 2026-07-21，OD-O1..O4 全按推荐值接受；post-#4359 doc-sync 复核 NO-DRIFT）| 未开始 | 未开始 | RATIFIED / landing——#4370 合入后即从新 main 开 runtime PR（§14 步骤 4）|
| Wave 3 / issue #4353 | #4414 stacked draft，head `8a10cdea5` | 旧基线实现存在，不可直接合 | 仅 stacked-base checks；无 main current-base required gate | RE-PORT-GATED |
| Wave 4 onboarding | 设计锁 `attendance-vnext-wave4-onboarding-design-lock-20260721.md`（**RATIFIED——待 owner 终裁 comment 生效**（re-ratify PR，§10 步③）：errata #4513=`57d89bc1d` 吸收④=(c) `manual_review_required`/③补信号/①前置票后，前置票 **W4-PRE-1 链已落地** #4521=`e20371b1a`+1b #4526=`3727cd92e`+1c #4530=`1a209a5cc`+1d #4534=`3d1b6cfaa`（各过 Opus 门；canonical surface=`POST /api/admin/users` 已回填 §3①；受控离职语义按 owner 裁决②③；`DIRECTORY_DEPROVISION_ENABLED` 默认 OFF），owner 终裁以 re-ratify PR comment 为凭据） | 未开始（W4-0 解冻可开工——从 re-ratify 合入后 main 起片；历史 WIP `claude/w4-0-setup-readiness-20260721`=`b2789cce7`（曾开 #4514 已 CLOSED 未合并）**仅作材料库逐项 re-port，禁整分支复活**——owner 裁决③） | 未开始 | RATIFIED / landing——W4-0 → W4-1 → W4-2（锁 §9 切片序，严格串行）；验证 MD 每片必出 |
| Wave 5 explainability | 数据合同设计锁 `attendance-vnext-wave5-explainability-data-contract-lock-20260722.md`（**PROPOSED——owner RATIFY 为唯一生效凭据**;2026-07-23 owner 终审三轮:一轮 0P1/3P2+**OD-W5-1..11 一次性全裁**、二轮 0P1/4P2/1P3(payload 面分级/actor wire 承载/lot 码映射/self 多组织四腿/W5-5 时序护栏)、三轮 0P1/2P2+授权时序 HOLD(self 目标读取 subject-constrained+G7 two-user 矩阵/⑤ lot item known-unknown discriminated union;owner 明示修订后 rebase+fresh checks 绿即以 PROPOSED 合入=锁 §10 步①,RATIFY 对合入后 exact SHA 请求)——三轮修订与裁决已全入锁;曾有受托代行已被 owner 收回,见锁 header 历史注记） | 未开始（runtime 未授权:owner 明示「呈审 → owner RATIFY → 再切 runtime」） | 未开始 | DATA-CONTRACT-GATED / 锁 PROPOSED（三轮吸收版,待合入后对 exact SHA RATIFY） |
| S7 runtime flag | 已交付并验证 | main 已有，默认 OFF | #4483 verification 已合且为刷新基线祖先 | OPERATOR-OPT-IN，非本线完成项 |
| 原生/硬件/飞书/多午夜 | 不在本总纲 | 未授权 | N/A | OUT / 独立立项 |

## 16. 参考

- `docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`
- `docs/development/attendance-v1-five-window-acceptance-verification-20260715.md`
- `docs/development/attendance-approval-s7-resolver-development-verification-20260719.md`
- `docs/development/attendance-ui-p0-hero-punch-design-lock-20260706.md`
- `docs/development/attendance-ui-p1-remainder-design-lock-20260707.md`
- PR #4359：attendance group setup workflow
- PR #4370：employee overview task-first design lock
- PR #4371：focused admin rail guard
- PR #4414：admin center task home stacked draft
