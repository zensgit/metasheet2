# 审批/工作流系统现状审计与下一阶段开发计划

Date: 2026-04-03

## 1. 结论先行

当前主仓已经不适合继续把主要研发资源放在多维表细节打磨上。

更合理的下一阶段主线是：

1. 把审批/工作流系统从“有引擎、有设计器、有部分业务接入”推进到“有统一产品入口和完整业务闭环”
2. 明确考勤审批、PLM 审批和通用 BPMN 工作流之间的产品边界
3. 停止把 `references/` 当成“可能还在运行的代码来源”理解，当前它更像参考资料库，而不是运行时依赖

一句话判断：

- 多维表：已达到 pilot/实施阶段
- 审批/工作流：已具备基础能力，但前台产品面未收平
- `references/`：存在参考借鉴，不是直接执行源

## 2. 为什么接下来该转向审批/工作流

当前仓库的几条主线里：

1. 多维表已经有完整工作台和多视图基础
2. 部署、发布、on-prem 文档链也已经补齐
3. 旧 PR 治理和最值的运维补丁也已收口

因此，继续开发最值的方向，不再是清理旧线，也不是继续补多维表局部 polish，而是补齐审批/工作流这条仍处在“能力 > 产品面”的系统。

## 3. 当前审批/工作流系统到底到了什么阶段

### 3.1 后端能力不是空壳

当前主仓里，审批/工作流相关后端已经真实存在：

- 工作流 API：
  [workflow.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow.ts)
- 工作流设计器 API：
  [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 通用审批 API：
  [approvals.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/approvals.ts)
- 审批历史 API：
  [approval-history.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/approval-history.ts)
- BPMN 引擎：
  [BPMNWorkflowEngine.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/BPMNWorkflowEngine.ts)
- 设计器模型：
  [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts)

并且它们已经挂进运行时：

- [index.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/index.ts#L548)

实际运行挂载包括：

1. `/api/workflow`
2. `/api/workflow-designer`
3. `/api/approvals/:id/history`
4. `/api/approvals/pending`
5. `/api/approvals/:id/approve`
6. `/api/approvals/:id/reject`

这说明审批/工作流后端不是概念层，已经有真实运行入口。

### 3.2 数据层也已经有基础表

通用审批表已经有 migration：

- [20250924105000_create_approval_tables.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/20250924105000_create_approval_tables.ts)

它创建了至少两张核心表：

1. `approval_instances`
2. `approval_records`

考勤领域又单独有一套审批流配置表：

- [zzzz20260120113000_create_attendance_approval_flows.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260120113000_create_attendance_approval_flows.ts)

这意味着当前系统实际上已经出现了两层审批概念：

1. 平台级审批实例/审批记录
2. 业务级审批流配置

这正是下一阶段必须统一建模的原因。

### 3.3 前端工作流产品面是存在的

前端已有真实工作流页面：

- [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)

路由里也真正挂了工作流入口：

- [appRoutes.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/router/appRoutes.ts#L136)

对应路径是：

1. `/workflows`
2. `/workflows/designer/:id?`

从界面结构看，当前已经不是简单 demo，而是包含：

1. Workflow Hub
2. 草稿目录
3. 模板目录
4. Team Views
5. 设计器
6. 校验、保存、部署动作

### 3.4 但审批产品面没有收平

这是当前最大的现实问题。

路由类型里已经预留了审批页：

- [types.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/router/types.ts#L62)

包括：

1. `approval-list`
2. `approval-detail`
3. `approval-create`
4. `approval-pending`
5. `approval-history`

路径常量也已经定义了：

- [types.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/router/types.ts#L368)

但实际前端并没有统一审批中心落地：

1. 路由表没有真正挂 `/approvals`
2. 当前代码里几乎没有前端页面消费 `/api/approvals`
3. `apps/web/src/stores` 下只有 [types.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/types.ts)，没有真正落地的 workflow/approval store

因此当前审批系统的状态不是“没有”，而是：

**后端基础完整度明显高于前端统一产品面。**

## 4. 业务侧的审批能力目前是怎样接进去的

### 4.1 考勤审批：已有业务配置，但更偏业务内嵌

考勤后台已经有审批流管理 UI：

- [AttendanceLeavePoliciesSection.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue)

它当前支持：

1. 请假类型是否需要审批
2. 加班规则是否需要审批
3. 审批流配置
4. 审批步骤 JSON 配置

这说明考勤审批不是空白，而是已经有业务内嵌式配置能力。

但当前问题是：

1. 它主要还是业务域内配置
2. 它尚未自然映射成一个平台统一审批中心
3. 审批流结构目前偏 JSON 配置，不是统一 designer-first 体验

### 4.2 考勤也已经接了设计器入口

考勤视角下也已经有工作流设计器包装页：

- [AttendanceWorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue)

这说明系统方向上已经明确：

**考勤审批并不是完全独立做一套，而是希望复用平台工作流能力。**

### 4.3 PLM 审批：已经有桥接模型

PLM 侧也不是从零开始，已经有桥接结构：

- [plm-approval-bridge.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/federation/plm-approval-bridge.ts)

它会把 PLM 审批映射成平台记录，例如：

1. `externalSystem: 'plm'`
2. `businessKey`
3. `workflowKey`
4. `status`
5. `requester`
6. `policy`

这很关键，因为它说明平台层已经不是单纯“做个审批页面”，而是在尝试把不同业务系统的审批收敛到一个统一语义层。

## 5. 当前审批/工作流系统的真实问题

### 5.1 产品入口不统一

当前统一工作流入口有了，但统一审批入口没有真正完成。

表现为：

1. `workflow` 有真实页面和路由
2. `approval` 有类型定义和后端 API
3. 但前端缺少真实审批中心页面与导航

### 5.2 业务模型还没真正统一

目前至少同时存在三种视角：

1. 通用审批实例/审批记录
2. 考勤审批流配置
3. PLM 审批桥接记录

这说明产品模型还没最终收平：

- 审批中心到底看“实例”还是“业务对象”
- 工作流设计器和考勤审批流配置是什么关系
- PLM 是只桥接展示，还是要真正纳入统一审批操作闭环

### 5.3 前端状态管理没收住

当前 `stores` 里只有类型：

- [types.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/types.ts)

但没有看到真正统一的 approval/workflow store 实现。

这通常意味着：

1. 设计方向在推进
2. 页面功能零散可用
3. 但还没形成完整的、可持续维护的审批产品状态层

### 5.4 workflow 还是 feature-gated

默认特性开关里：

- [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts#L29)

`workflow` 默认是 `false`。

这说明它当前更像：

1. 可启用能力
2. 内部/租户灰度能力
3. 还不是完全默认全量开放的成熟模块

## 6. `references/` 里的代码有没有直接执行

结论：

**当前主系统没有直接执行 `references/` 里的代码。**

`references/` 下主要有三套参考：

- [references/univer](/Users/huazhou/Downloads/Github/metasheet2/references/univer)
- [references/apitable](/Users/huazhou/Downloads/Github/metasheet2/references/apitable)
- [references/nocobase](/Users/huazhou/Downloads/Github/metasheet2/references/nocobase)

但在主代码中没有查到直接 import/require 这些路径的运行时代码。

实际情况更接近：

1. `references/` 是参考资料库
2. 当前主系统是自主实现
3. 部分能力明显借鉴了参考项目的设计思路

其中借鉴最明显的是 `univer` 路径：

- 当前多维表核心路由是 [univer-meta.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts)
- 主运行时里也直接挂了 `/api/multitable` 和 dev alias `/api/univer-meta`
  见 [index.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/index.ts#L571)

因此更准确的说法是：

**有参考和吸收，但不是把 `references/` 目录当运行时代码执行。**

## 7. 对当前系统的判断

### 7.1 多维表当前判断

多维表当前更接近：

1. pilot 可实施
2. on-prem 可部署
3. 与飞书风格接近，但未达到飞书成熟产品级 parity

所以多维表当前应该进入：

- pilot 实施
- 反馈驱动修补
- 而不是持续做大面积主线开发

### 7.2 审批/工作流当前判断

审批/工作流当前更接近：

1. 后端基础能力已具备
2. 前端 workflow 产品面已有雏形
3. 审批产品面仍不完整
4. 业务接入路径分散在考勤、PLM、通用平台能力中

所以审批/工作流现在最适合做：

**产品化收口，而不是继续散点补丁。**

## 8. 下一阶段开发建议

建议把下一阶段拆成 3 步。

### Phase A：审批/工作流现状收模

目标：

把当前零散能力变成统一模型。

要做的事：

1. 画清领域模型
   - Workflow Definition
   - Workflow Instance
   - Approval Instance
   - Approval Record
   - Attendance Approval Flow
   - PLM Approval Bridge
2. 明确“审批中心”的主对象是什么
3. 明确通用审批与业务审批的边界
4. 明确哪些业务继续桥接，哪些业务直接内嵌

建议产物：

1. 系统模型图
2. 路由/表结构映射表
3. 前后端契约表

### Phase B：统一审批中心 MVP

目标：

补齐前台产品面。

最低可交付范围建议是：

1. `/approvals`
2. `/approvals/pending`
3. `/approvals/history`
4. `/approvals/:id`

MVP 能力建议：

1. 待办审批列表
2. 已处理审批历史
3. 审批详情
4. approve / reject 操作
5. 审批轨迹展示
6. 基础筛选：状态、来源系统、更新时间

这一步不要同时追求：

1. 全业务深度打通
2. 全通知中心
3. 全自动化

先把“统一审批入口”做出来。

### Phase C：业务接入统一化

目标：

把考勤和 PLM 接到统一审批体验。

建议顺序：

1. 先接考勤
   - 因为考勤已经有审批流配置和实际业务场景
2. 再接 PLM
   - 因为 PLM 目前更像桥接和 preview 语义

这一阶段重点：

1. 考勤审批流是否继续保留 JSON steps
2. 是否逐步迁到 designer-first
3. PLM 是只桥接状态，还是允许统一审批动作反写

## 9. 建议的开发优先级

按价值排序，我建议：

1. 审批/工作流系统建模与入口统一
2. 审批中心 MVP 页面
3. 考勤审批接统一审批中心
4. PLM 审批桥接收口
5. 多维表继续按 pilot 反馈补缺，不作为当前主线

## 10. 不建议的做法

当前不建议：

1. 继续沿旧 PR 线做零散修补
2. 继续把主要资源投到多维表细枝末节 polish
3. 继续把审批分散在各业务页面里，不建设统一审批中心
4. 误以为 `references/` 目录里的代码仍在主系统直接运行

## 11. 最终建议

当前最好的开发主线是：

**从“多维表主线开发”切换到“审批/工作流系统产品化收口”。**

具体来说：

1. 先做审批/工作流系统审计定稿
2. 再做统一审批中心 MVP
3. 再把考勤和 PLM 接上来

这是当前最值、最能形成下一阶段产品增长面的方向。
