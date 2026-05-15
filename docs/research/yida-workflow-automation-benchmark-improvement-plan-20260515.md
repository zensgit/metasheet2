# 宜搭流程与集成自动化对标改善方案

生成日期：2026-05-15  
适用仓库：`metasheet2`  
文档性质：对标改善方案，供后续 TODO、开发设计和验证拆分使用  
前置对照文档：`docs/research/yida-workflow-vs-metasheet2-comparison-20260514.md`

## 1. 结论

MetaSheet2 当前已经具备流程与自动化开发的底座，但宜搭的成熟点不是单个 BPMN 引擎，而是“表单数据 - 审批任务 - 自动化编排 - 运行治理 - 通知与权限”的产品闭环。

因此建议不要直接照搬成一个大而全的 BPMN 平台。更稳的路线是：

1. 以多维表记录、公开表单、审批实例为统一业务入口。
2. 先补审批人解析、字段权限、任务中心、审批动作和 SLA 超时。
3. 再补自动化运行中心、失败重试、持久调度和编排节点。
4. 最后把 Workflow Designer/BPMN 作为高级建模入口，映射到稳定的审批与自动化运行时。

### 1.1 与 2026-05-14 对照文档的结合结论

`docs/research/yida-workflow-vs-metasheet2-comparison-20260514.md` 与本文不是冲突关系，二者关注点不同：

- 2026-05-14 文档更偏“审批/BPMN 内核打磨”，给出了高 ROI 的 Wave A/B：版本冻结、自动审批三合并、管理员跳转、加签、超时 5 动作、字段权限、dry-run。
- 本文更偏“宜搭产品闭环”，把多维表、公开表单、审批实例、自动化运行治理串起来。

结合后的总路线应改为“两层推进”：

1. **内核正确性前置**：先做版本冻结、自动审批三合并、管理员跳转、加签。这些能力不增加新产品面，但能避免正在运行的审批实例被定义变更、人员变更和异常节点卡死影响。
2. **业务闭环随后展开**：在内核语义稳定后，再做公开表单/多维表记录触发审批、审批结果回写、`start_approval` 自动化动作。
3. **运行治理贯穿后续阶段**：自动化重跑、SLA 超时动作、工作日历、持久调度作为第二批稳定性能力进入。
4. **BPMN 高级能力后置**：子流程、抄送节点、手写签名、流程分析、模板市场不进入第一轮核心闭环，除非客户明确要求。

因此，本文后续优先级已按该结合结论调整：`版本冻结`、`自动审批三合并`、`管理员跳转`、`加签` 从“增强项”上调为第一阶段内核项。

## 2. 对标来源

本方案依据以下宜搭文档能力归纳：

| 宜搭能力 | 参考链接 | 本方案使用点 |
|---|---|---|
| 流程简介 | https://docs.aliwork.com/docs/yida_support/_2/crwfii | 流程表单、流程生命周期、产品边界 |
| 流程属性设置 | https://docs.aliwork.com/docs/yida_support/_2/qgaxvq | 版本、权限、通知、自动审批、超时 |
| 审批人节点 | https://docs.aliwork.com/docs/yida_support/_2/trbqg6/rq8i94 | 审批人来源、空审批人、多人审批 |
| 条件分支 | https://docs.aliwork.com/docs/yida_support/_2/trbqg6/_1/yv8dnv | 字段条件、分支执行语义 |
| 流程权限设置 | https://docs.aliwork.com/docs/yida_support/_2/ef8e88/daeh3v | 发起权限、节点字段权限 |
| 消息通知 | https://docs.aliwork.com/docs/yida_support/_2/ef8e88/aglbg3 | 节点通知、模板、钉钉/邮件 |
| 流程任务中心 | https://docs.aliwork.com/docs/yida_support/_2/ea1o8cgypga0lh9t/hg13tb | 待办、已办、抄送、我发起 |
| 集成&自动化 | https://docs.aliwork.com/docs/yida_support/_3/gqmveiswrxkgxu9s | 触发器、节点编排、运行日志 |
| 自动化表单新增触发 | https://docs.aliwork.com/docs/yida_support/_3/yovph5uaoyxb6f02/yl45mtqgbwewybhk/ovoh2nmd58k21t97 | 表单事件触发自动化 |
| 顺序执行节点 | https://docs.aliwork.com/docs/yida_support/_3/yovph5uaoyxb6f02/gd8wqzg0reppv4fk | 多步骤动作、执行链路 |
| 自动化运行日志 | https://docs.aliwork.com/docs/yida_support/_3/scg1tid03znsk3px | 执行详情、异常定位、运行治理 |

## 3. 当前代码基线

### 3.1 自动化底座

当前自动化已经有可继续演进的基础：

- 触发器和动作白名单在 `packages/core-backend/src/multitable/automation-service.ts`。
- 执行流水线在 `packages/core-backend/src/multitable/automation-executor.ts`。
- 简化 cron 和 interval 调度在 `packages/core-backend/src/multitable/automation-scheduler.ts`。
- 执行日志在 `packages/core-backend/src/multitable/automation-log-service.ts`。
- 前端规则编辑器在 `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`。
- 测试、日志和统计路由在 `packages/core-backend/src/routes/automation.ts`。

已具备：

- 记录创建、更新、删除，字段变更，定时，webhook received 触发类型。
- 更新记录、创建记录、发送 webhook、站内通知、邮件、钉钉群、钉钉个人、锁定记录等动作。
- 嵌套条件组。
- 执行日志、统计、手动测试。
- 调度 leader lock 和递归深度保护。

主要缺口：

- `webhook.received` 更像规则类型，缺少完整的 inbound endpoint、签名校验和触发审计。
- 自动化动作当前偏线性，前端限制 1-3 步，缺分支、循环、错误处理节点。
- 执行日志已有，但缺执行重跑、失败步骤重试、异常提醒、异常规则自动暂停。
- 简化 cron 不足以支撑 timezone、misfire、工作日规则。
- 没有持久任务队列，调度仍是内存 timer + leader lock。

### 3.2 审批产品底座

当前审批产品已有较多可复用能力：

- 表单字段显隐和校验在 `packages/core-backend/src/services/ApprovalGraphExecutor.ts`。
- 审批图推进、会签/或签、并行分支在 `ApprovalGraphExecutor`。
- 审批模板、实例和动作在 `packages/core-backend/src/services/ApprovalProductService.ts` 与 `packages/core-backend/src/routes/approvals.ts`。
- SLA 扫描在 `packages/core-backend/src/services/ApprovalSlaScheduler.ts`。
- 前端审批中心路由在 `apps/web/src/router/appRoutes.ts`。

已具备：

- approval graph、form schema、field visibility rule。
- `single`、`all`、`any` 审批模式。
- 并行分支状态持久到实例 metadata。
- 空审批人自动通过或报错的基础语义。
- approve、reject、transfer、revoke、comment、return 动作入口。
- remind 催办和 SLA breach notifier。
- pending-count、read marker、审批历史、指标。

主要缺口：

- 审批人来源仍偏静态 user/role，缺字段取人、主管链、发起人自选、动态角色、组织成员组等解析。
- 缺节点级字段权限三态：可编辑、只读、隐藏。
- 缺代理/委托中心、加签、退回到指定节点、撤回后重新提交等完整人处理动作。
- SLA 只有 hours 维度，缺节点级超时动作、重复提醒、工作日/不计时时段。
- 审批实例与多维表记录/公开表单的触发和回写闭环不完整。

### 3.3 Workflow Designer/BPMN 底座

当前 Workflow Designer 适合作为高级建模入口，但不应作为第一阶段唯一运行时：

- 工作流路由挂载在 `packages/core-backend/src/index.ts`。
- 设计器 API 在 `packages/core-backend/src/routes/workflow-designer.ts`。
- BPMN 引擎在 `packages/core-backend/src/workflow/BPMNWorkflowEngine.ts`。
- 前端设计器在 `apps/web/src/views/WorkflowDesigner.vue`。
- Workflow Hub 在 `apps/web/src/views/WorkflowHubView.vue`。

已具备：

- 模板、草稿、部署、验证、测试入口。
- node catalog、team view、saved view、archive/restore。
- BPMN 部署、启动实例、任务、message/signal 等基础路由。

主要缺口：

- 通用 BPMN runtime 与审批产品 runtime 没有清晰统一边界。
- BPMN 节点没有完整映射到审批人解析、字段权限、任务中心、自动化运行日志。
- 仍有 workflow mock endpoint，说明通用运行时还不应直接承载核心生产闭环。

## 4. 功能对标改善矩阵

| 对标能力 | 当前状态 | 改善做法 | 优先级 |
|---|---|---|---|
| 版本冻结 | 部分有 version 字段 | 发布版本快照、历史实例绑定版本、未完结实例禁止删除版本 | P0 |
| 自动审批三合并 | 空审批人有基础，无发起人/相邻/历史审批人去重 | 新增 requester merge、adjacent merge、history dedupe，节点级优先于全局 | P0 |
| 管理员跳转节点 | 缺 | 管理员可将 stuck 实例跳转到合法目标节点，关闭旧 assignment 并审计 | P0 |
| 加签 | 缺 | 支持前加签、后加签、并行加签，写 runtime inserted nodes 和审计记录 | P0 |
| 流程表单强绑定 | 多维表、公开表单、审批模板分散 | 建立“记录/表单提交触发审批”的统一绑定模型 | P0 |
| 审批人来源 | user/role 静态为主 | 新增 `ApprovalAssigneeResolver`，支持字段、角色、发起人、主管链 | P0 |
| 节点字段权限 | 有字段显隐，无节点权限三态 | 在模板版本中保存 node field permissions，运行时按节点裁剪 | P1 |
| 任务中心 | 有审批中心和 pending-count | 聚合待办、已办、抄送、我发起、超时、来源筛选 | P1 |
| 转交/退回/撤回/评论 | actions 入口有部分动作 | 明确状态机和审计记录，补 UI 与并发校验 | P1 |
| 节点提交关联操作 | 缺审批动作到自动化 trigger 桥 | 发出 `approval.<action>.completed` 事件，由 multitable automation 处理回写/关联 | P1 |
| 代理/委托 | 缺 | 新增 delegation 表与任务查询代理扩展 | P2 |
| 超时动作 | 只有 SLA breach/remind | 节点级 timeout rules：提醒、转交、跳转、自动同意、自动拒绝 | P2 |
| 工作日/不计时时段 | 缺 | 引入 business calendar，复用考勤节假日能力或独立日历表 | P2 |
| 自动化运行日志 | 有日志和统计 | 新增执行详情、整条重跑、失败步骤重试、异常提醒 | P0 |
| 自动化编排节点 | 当前偏 1-3 线性动作 | 增加 sequence、branch、loop、error handler 模型 | P3 |
| 自动化持久调度 | 内存 timer + leader lock | 增加 persistent job queue、full cron、timezone、misfire 策略 | P2 |
| BPMN 高级入口 | 已有设计器和引擎 | 先映射到审批/自动化运行时，再逐步硬化 BPMN engine | P3 |
| 编辑器 dry-run | 有 test 入口但不完整 | 提供不写库的模拟执行 trace 和节点高亮 | P2 |
| 子流程 callActivity | BPMN 名称露出但执行不完整 | 子实例、父实例等待、变量映射、错误传播 | P3 |
| 抄送独立节点 | cc 仅为视图 tab | 非阻塞 cc 节点，发送通知后立即通过 | P3 |
| 手写签名 | 缺 | 节点级签名开关、签名图片引用、移动端/PC 上传 | P3 |

## 5. 详细改善方案

### 5.1 统一“业务数据触发审批”入口

#### 目标

让多维表记录和公开表单提交能够直接触发审批流程，并在审批完成后回写记录。对标宜搭“流程表单”的核心价值。

#### 建议模型

新增或扩展绑定表：

```sql
CREATE TABLE approval_trigger_bindings (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  template_id UUID NOT NULL,
  template_version_id UUID,
  source_type TEXT NOT NULL,
  sheet_id TEXT,
  view_id TEXT,
  trigger_event TEXT NOT NULL,
  trigger_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  form_field_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`source_type` 建议先支持：

- `multitable_record`
- `public_form_submission`
- `manual`
- 后续再扩展 `automation_action`

`trigger_event` 建议先支持：

- `record.created`
- `record.updated`
- `form.submitted`

#### 后端改造

1. 在 `univer-meta.ts` 的记录创建、公开表单提交成功路径发出领域事件。
2. 新增 `ApprovalTriggerBindingService`：
   - 查询启用绑定。
   - 用 `trigger_condition` 匹配记录字段。
   - 将记录字段映射为审批 `formData`。
   - 调用 `ApprovalProductService` 创建审批实例。
   - 将 `sourceSnapshot` 写入 `approval_instances.metadata`。
3. 审批结束时发布 `approval.completed`、`approval.rejected` 事件。
4. 新增结果回写服务：
   - 根据 `result_mapping` 更新多维表记录状态、审批编号、审批人、完成时间、拒绝原因。

#### 前端改造

1. 在多维表视图或表单分享配置中增加“提交后发起审批”设置。
2. 在审批模板详情增加“触发来源”页签。
3. 在记录详情 drawer 中展示关联审批实例列表和当前状态。

#### 验收标准

- 管理员能把一个审批模板绑定到公开表单提交。
- 匿名或钉钉受保护表单提交后，系统创建审批实例。
- 审批通过后，多维表记录状态自动更新为 approved。
- 审批拒绝后，多维表记录状态自动更新为 rejected，并写入拒绝原因。
- 触发失败不影响原始表单提交，但必须写入错误日志和管理员可见告警。

#### 测试建议

- `packages/core-backend/tests/unit/approval-trigger-binding.test.ts`
- `packages/core-backend/tests/integration/public-form-approval-trigger.test.ts`
- `apps/web/tests/multitable-approval-trigger-settings.spec.ts`

### 5.2 审批人解析器

#### 目标

把宜搭“审批人节点”的人来源能力产品化，避免所有审批节点都只能配置静态 user/role。

#### 建议接口

```ts
export type AssigneeSource =
  | { type: 'static_user'; userIds: string[] }
  | { type: 'role'; roleIds: string[] }
  | { type: 'requester' }
  | { type: 'form_field_user'; fieldId: string }
  | { type: 'form_field_member_group'; fieldId: string }
  | { type: 'supervisor_chain'; from: 'requester' | 'field_user'; fieldId?: string; levels: number }
  | { type: 'department_role'; departmentFieldId: string; roleId: string };

export interface AssigneeResolutionResult {
  assignments: Array<{
    assignmentType: 'user' | 'role';
    assigneeId: string;
    source: AssigneeSource['type'];
  }>;
  warnings: string[];
  snapshot: Record<string, unknown>;
}
```

#### 策略配置

审批节点配置建议扩展：

```ts
type ApprovalNodeConfig = {
  assigneeSources: AssigneeSource[];
  approvalMode: 'single' | 'all' | 'any';
  emptyAssigneePolicy: 'error' | 'auto-approve' | 'skip-node' | 'escalate';
  dedupePolicy?: {
    requesterAutoApprove?: boolean;
    adjacentSameApproverAutoApprove?: boolean;
    historicalApproverAutoApprove?: boolean;
  };
  fallbackAssigneeSource?: AssigneeSource;
};
```

#### 运行时规则

1. 审批实例创建时解析审批人，并写入快照。
2. 实例推进到某个节点时，默认使用快照，不因组织变更自动改变历史实例。
3. 如果节点配置允许“实时解析”，必须在审计记录中写明重新解析原因。
4. 空审批人按节点策略执行：
   - `error`：阻断发起或阻断推进。
   - `auto-approve`：生成 auto approval record。
   - `skip-node`：直接跳到下一个节点，但记录跳过原因。
   - `escalate`：转给兜底审批人。

#### 代码落点

- 新增 `packages/core-backend/src/services/ApprovalAssigneeResolver.ts`。
- 扩展 `ApprovalProductService` 的 graph normalize 和 instance creation。
- 扩展 `ApprovalGraphExecutor` 的 assignment 输出，保留兼容旧的 `assigneeType`/`assigneeIds`。
- 前端模板详情、模板编辑器展示新配置。

#### 验收标准

- 能从表单字段读取用户作为审批人。
- 能解析角色审批人。
- 能配置发起人自动通过。
- 能配置相邻审批人相同自动通过。
- 能配置历史已审批人后续节点自动通过。
- 空审批人能按策略报错、自动通过或转兜底人。

### 5.3 节点字段权限三态

#### 目标

对标宜搭“节点字段权限”：发起、审批、执行、抄送、查看状态下，每个字段可以可编辑、只读、隐藏。

#### 建议模型

在模板版本或 approval graph 节点配置中保存：

```ts
type FieldPermission = 'editable' | 'readonly' | 'hidden';

type NodeFieldPermissions = {
  nodeKey: string;
  defaultPermission: FieldPermission;
  fields: Record<string, FieldPermission>;
};
```

#### 后端规则

1. 读取审批详情时，根据当前用户、当前节点、任务身份应用字段权限。
2. 提交审批动作时，只接受当前节点允许编辑的字段。
3. 隐藏字段不能出现在 API response 的 formData 中，或必须脱敏为空值。
4. 只读字段可返回但不可修改。
5. 字段显隐规则和字段权限同时存在时，优先级建议：
   - 字段显隐规则先判断字段是否在当前表单逻辑中可见。
   - 节点权限再决定 editable/readonly/hidden。
   - 任一层 hidden 即 hidden。

#### 前端规则

1. `ApprovalDetailView` 根据权限渲染字段。
2. `TemplateDetailView` 展示每个节点字段权限。
3. 发起审批页按 start 节点权限渲染。

#### 验收标准

- 同一审批实例，不同节点看到的字段权限不同。
- 抄送人只能只读或隐藏。
- 后端拒绝修改只读/隐藏字段。
- API 响应不泄露 hidden 字段值。

### 5.4 审批任务中心增强

#### 目标

把当前审批中心升级为宜搭式任务中心：待办、已办、抄送、我发起、超时、来源筛选、搜索、批量操作。

#### 建议 API

```http
GET /api/approvals/tasks?tab=pending|done|cc|requested|overdue|all
GET /api/approvals/tasks/:taskId
POST /api/approvals/tasks/bulk-action
```

查询参数：

- `sourceSystem`
- `workflowKey`
- `templateId`
- `requester`
- `assignee`
- `status`
- `keyword`
- `overdueOnly`
- `cursor`/`limit`

#### 数据规则

1. pending：当前用户直接 assignment 或角色 assignment。
2. done：用户已处理过的实例。
3. cc：用户收到抄送但不阻塞流程。
4. requested：用户发起的流程。
5. overdue：当前用户待办且超时，或管理员查看全部超时。
6. all：管理员或具有权限用户可见。

#### 前端规则

1. `ApprovalCenterView` 改成任务中心布局。
2. 列表行展示：标题、来源、当前节点、发起人、到达时间、剩余时间、状态、操作。
3. 支持从多维表记录进入审批详情，也支持从审批详情回到记录。
4. 支持批量已读、批量催办、批量审批仅在策略允许时开放。

#### 验收标准

- 待办数量与列表一致。
- 抄送不进入待办计数。
- 角色审批人可以看到任务。
- 已办列表基于 approval_records。
- 多来源审批可以按来源系统过滤。

### 5.5 人处理动作补齐

#### 目标

补齐宜搭类审批中的常用动作：加签、转交、代理、退回、撤回、重新提交、评论、催办。

#### 动作语义

| 动作 | 说明 | 状态影响 |
|---|---|---|
| approve | 同意当前任务 | 可能推进节点 |
| reject | 拒绝流程 | 实例终态 rejected |
| comment | 仅评论 | 不改变状态 |
| remind | 催办 | 不改变状态，写记录和通知 |
| transfer | 转交当前任务 | 当前 assignment 失效，新 assignment 生效 |
| return | 退回指定节点或发起人 | currentNodeKey 改变，后续 assignment 重建 |
| revoke | 发起人撤回 | 实例终态 revoked 或回到 draft |
| resubmit | 撤回/退回后重新提交 | 创建新版本或复用实例继续 |
| add_sign_before | 前加签 | 当前任务前插入临时审批节点 |
| add_sign_after | 后加签 | 当前任务后插入临时审批节点 |

#### 关键设计

1. 所有动作必须写 `approval_records`。
2. 所有状态变更必须校验 `version`，避免并发重复审批。
3. 临时加签节点写入 `approval_instances.metadata.runtimeInsertedNodes`。
4. 退回到指定节点必须校验目标节点存在且可达。
5. 代理审批要在记录中标记 `actedBy` 和 `onBehalfOf`。

#### 代理/委托表

```sql
CREATE TABLE approval_delegations (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_user_id TEXT NOT NULL,
  delegate_user_id TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`scope` 支持：

- 全部审批
- 指定模板
- 指定来源系统
- 指定时间范围

#### 验收标准

- 转交后原审批人不再能处理。
- 代理人能在任务中心看到被代理任务。
- 代理处理后审计记录展示代理关系。
- 退回到指定节点会重建目标节点 assignment。
- 加签节点能被处理并继续回到原流程。

### 5.6 SLA 与超时动作

#### 目标

把当前 SLA breach 扩展为宜搭式节点超时规则。

#### 建议模型

```ts
type TimeoutRule = {
  enabled: boolean;
  duration: {
    unit: 'minute' | 'hour' | 'natural_day' | 'business_day';
    value: number;
    calendarId?: string;
  };
  reminders?: {
    maxCount: number;
    intervalMinutes: number;
  };
  action:
    | { type: 'remind' }
    | { type: 'transfer'; assigneeSource: AssigneeSource }
    | { type: 'jump'; targetNodeKey: string }
    | { type: 'auto_approve' }
    | { type: 'auto_reject'; reasonTemplate?: string };
};
```

#### 数据模型

```sql
CREATE TABLE approval_deadlines (
  id UUID PRIMARY KEY,
  instance_id TEXT NOT NULL,
  assignment_id UUID,
  node_key TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  rule_snapshot JSONB NOT NULL,
  reminder_count INT NOT NULL DEFAULT 0,
  last_reminded_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### 执行规则

1. 创建 assignment 时生成 deadline。
2. `ApprovalSlaScheduler` 改为扫描 `approval_deadlines`。
3. 到期后按规则执行动作。
4. 自动同意/拒绝必须写 approval record，actor 标记为 `system:timeout`.
5. 超时转交和跳转必须保留原节点上下文，方便审计。

#### 工作日与不计时时段

第一阶段可以先实现：

- natural day
- hour
- minute

第二阶段接入 business calendar：

- 复用考勤节假日表或新增 `business_calendars`。
- 支持工作日计算。
- 支持不计时时段。

#### 验收标准

- 超时提醒不会无限重复。
- 自动拒绝/同意会推进实例到正确状态。
- 超时转交后新审批人能看到任务。
- 非 leader 节点不会重复执行超时动作。

### 5.7 自动化运行中心

#### 目标

把当前“规则卡片 + 日志弹窗”升级为可运营的自动化运行中心，对标宜搭运行日志和异常提醒。

#### 当前基础

已有：

- `multitable_automation_executions`。
- `AutomationExecution.steps`。
- logs、stats、manual test。
- webhook 内部简单 retry。

缺少：

- 整条执行重跑。
- 失败步骤重试。
- 执行入队和持久 attempt。
- 异常提醒。
- 批量查看所有规则的失败运行。

#### 建议数据模型

```sql
CREATE TABLE automation_execution_attempts (
  id UUID PRIMARY KEY,
  execution_id TEXT NOT NULL,
  attempt_no INT NOT NULL,
  status TEXT NOT NULL,
  trigger_event JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  error TEXT,
  created_by TEXT
);
```

#### 建议 API

```http
GET /api/multitable/automation-executions?sheetId=&status=&ruleId=
GET /api/multitable/automation-executions/:executionId
POST /api/multitable/automation-executions/:executionId/retry
POST /api/multitable/automation-executions/:executionId/support-packet
```

第一阶段先实现整条重跑，不做步骤级重跑。原因：

- 整条重跑可以复用现有 `AutomationService.executeRule`。
- 步骤级重跑需要动作幂等、上下文回放和前置步骤输出依赖，复杂度更高。

#### 重跑语义

1. 仅允许重跑 failed 或 skipped 的 execution。
2. 重跑使用原始 `triggerEvent` 快照。
3. 重跑必须写新 execution，不覆盖旧日志。
4. 重跑必须记录操作者。
5. 对会产生外部副作用的动作，要求规则显式声明 idempotency key 或弹出风险确认。

#### 异常提醒

新增规则级异常策略：

```ts
type AutomationFailurePolicy = {
  notifyOwner: boolean;
  notifyChannels: Array<'in_app' | 'email' | 'dingtalk'>;
  autoDisableAfterConsecutiveFailures?: number;
};
```

#### 前端改造

1. 新增 Automation Runs 页面。
2. 规则卡片展示最近失败、连续失败次数、最后执行时间。
3. 日志详情展示 steps、输入、输出、错误、脱敏支持包。
4. 提供 Retry 按钮。

#### 验收标准

- 失败执行可以从 UI 重跑。
- 重跑产生新的 execution id。
- 支持包不泄露 webhook token、DingTalk secret、Bearer token。
- 连续失败达到阈值后规则自动 disabled，并写 audit log。

### 5.8 自动化触发器和动作扩展

#### 新增触发器

建议加入：

- `public_form.submitted`
- `approval.created`
- `approval.approved`
- `approval.rejected`
- `approval.returned`
- `approval.timeout`
- `automation.failed`

#### 新增动作

建议加入：

- `start_approval`
- `update_approval_context`
- `comment_record`
- `create_task`
- `branch`
- `loop_over_records`
- `delay`
- `wait_until`

第一阶段只做 `start_approval` 和 `approval.*` 事件触发。

#### `start_approval` 动作配置

```ts
type StartApprovalActionConfig = {
  templateId: string;
  formDataMapping: Record<string, string>;
  sourceRecord?: {
    sheetIdPath?: string;
    recordIdPath?: string;
  };
  resultMapping?: Record<string, string>;
};
```

#### 验收标准

- 自动化规则能在记录创建时发起审批。
- 审批完成能触发另一条自动化。
- 触发链路受 `MAX_AUTOMATION_DEPTH` 或新的 chain guard 限制。

### 5.9 自动化编排节点

#### 目标

对标宜搭“顺序执行、分支、循环、数据处理、连接器”，但分阶段做。

#### 第一阶段

保持现有 actions 数组，增加：

- action name
- continueOnError
- timeoutMs
- idempotencyKeyTemplate

```ts
type AutomationAction = {
  id: string;
  name?: string;
  type: AutomationActionType;
  config: Record<string, unknown>;
  continueOnError?: boolean;
  timeoutMs?: number;
  idempotencyKeyTemplate?: string;
};
```

#### 第二阶段

引入 DAG 编排模型：

```ts
type AutomationNode =
  | { id: string; type: 'action'; action: AutomationAction }
  | { id: string; type: 'branch'; conditions: ConditionGroup[] }
  | { id: string; type: 'loop'; collectionPath: string; body: AutomationNode[] };
```

#### 不建议立刻做

- 可视化无限画布。
- 任意脚本节点。
- 任意外部连接器市场。

这些能力需要沙箱、配额、安全审计和连接器凭证管理，建议在运行中心和队列稳定后再做。

### 5.10 调度与持久队列

#### 目标

把当前内存 timer 调度升级为可靠执行。

#### 改善项

1. 使用 full cron parser，支持 timezone。
2. 新增 persistent job 表：

```sql
CREATE TABLE automation_jobs (
  id UUID PRIMARY KEY,
  rule_id TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

3. scheduler 只负责生成 job。
4. worker 负责领取 job、执行、重试。
5. misfire 策略：
   - `skip`
   - `run_once`
   - `catch_up_limited`

#### 验收标准

- 服务重启后不会丢失已计划任务。
- 多副本下同一 job 只执行一次。
- cron timezone 生效。
- 错过窗口按配置处理。

### 5.11 版本冻结与发布生命周期

#### 目标

对标宜搭“设计中/启用中/历史版本”和“历史数据不受新版本影响”。

#### 状态模型

```ts
type ProcessVersionStatus = 'draft' | 'active' | 'history' | 'archived';
```

#### 规则

1. 模板发布时生成 immutable version snapshot。
2. 审批实例绑定 `template_version_id` 和 graph snapshot。
3. 新发布版本不影响已发起实例。
4. 有未完结实例的版本不能硬删除。
5. 历史版本可以复制为新草稿。

#### 代码落点

- `approval_template_versions`
- `approval_instances.template_version_id`
- `workflow_definitions.status`
- `workflow_templates`

#### 验收标准

- 修改模板后，旧实例仍按旧图推进。
- 活跃实例存在时，版本删除被拒绝。
- 版本列表可展示发布人、发布时间、备注、实例数。

### 5.12 自动审批三合并

#### 目标

吸收 2026-05-14 对照文档中的高 ROI 建议，优先补齐宜搭式自动审批合并规则，降低重复审批噪音。

#### 策略

```ts
type AutoApprovalPolicy = {
  mergeWithRequester?: boolean;
  mergeAdjacentApprover?: boolean;
  dedupeHistoricalApprover?: boolean;
  scope?: 'global' | 'node';
  actorMode?: 'system' | 'original_approver';
};
```

#### 执行语义

1. 节点级策略优先于全局策略。
2. `mergeWithRequester`：当前审批人等于发起人时自动通过。
3. `mergeAdjacentApprover`：当前节点审批人与上一个阻塞审批节点处理人相同，则自动通过；抄送节点不参与相邻判断。
4. `dedupeHistoricalApprover`：当前审批人已经在本实例内完成过审批，则自动通过。
5. 所有自动通过都必须写 `approval_records`，`actor_id` 建议默认 `system:auto-approval`，metadata 记录命中的策略、原审批人和节点。

#### 代码落点

- `ApprovalGraphExecutor`：输出 auto approval events 已有基础，可扩展 reason。
- `ApprovalProductService`：创建 assignment 前或节点推进时应用策略。
- `approval_template_versions`：保存全局策略和节点覆盖策略。
- 前端模板详情：展示策略来源和命中行为。

#### 验收标准

- 发起人审批自己时自动通过。
- 相邻审批人相同时自动通过，且抄送不影响相邻判断。
- 历史已审批人再次出现时自动通过。
- 三种规则均有审计记录。
- 关闭策略后不再自动通过。

### 5.13 管理员跳转节点

#### 目标

提供运维兜底能力。对标宜搭在审批人离职、主管解析失败、流程 stuck 时的手工跳转节点能力。

#### API 草案

```http
POST /api/approvals/:id/jump
POST /api/workflow/instances/:id/jump
```

请求体：

```json
{
  "targetNodeKey": "approval_finance",
  "reason": "原审批人离职，管理员跳转到财务审批节点",
  "version": 12
}
```

#### 执行规则

1. 调用者必须具备 `approvals:admin` 或专用 `workflow:admin_jump` 权限。
2. 目标节点必须存在于当前实例绑定的版本快照中。
3. 目标节点必须是可进入的运行节点，不能是非法结束态。
4. 当前 active assignments 全部关闭，metadata 标记 `closedByJump=true`。
5. 目标节点重新解析 assignments。
6. 写入 `approval_records`，action 建议为 `jump`，记录 fromNode、toNode、reason、actor。
7. 发布 `approval.jumped` 事件，用于通知和自动化联动。

#### 与 return 的区别

- `return` 是业务审批动作，通常由审批人发起，语义是退回修改。
- `jump` 是管理员运维动作，用于恢复异常实例，必须强审计、强权限、不可静默。

#### 验收标准

- 无权限用户调用返回 403。
- 跳转后旧审批人无法继续处理旧任务。
- 新节点审批人能在任务中心看到任务。
- 详情页时间线展示管理员跳转记录。
- 跳转不改变实例绑定的版本快照。

### 5.14 编辑器 dry-run 与 trace

#### 目标

吸收旧对照文档中的“编辑器模拟测试”建议。设计阶段能用样例变量跑出路径 trace，不写真实审批实例。

#### API 草案

```http
POST /api/workflow-designer/workflows/:id/simulate
POST /api/approval-templates/:id/simulate
```

响应：

```ts
type SimulationResult = {
  status: 'completed' | 'pending' | 'stuck' | 'failed';
  trace: Array<{
    nodeKey: string;
    nodeType: string;
    enteredAt: string;
    outcome: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    warnings: string[];
  }>;
};
```

#### 验收标准

- 不写 `approval_instances`。
- 能展示条件分支命中路径。
- 能展示审批人解析结果。
- 缺字段、无审批人、条件无分支命中时返回可读 warning。

## 6. 推荐分阶段计划

### Phase 0：方案固化与现状清理

预计 0.5-1 天。

任务：

- 确认本方案范围。
- 将当前考勤/公式未提交改动隔离，避免新开发混入。
- 从现有 comparison 文档拆出正式 TODO。

产出：

- `docs/development/workflow-automation-yida-benchmark-todo-20260515.md`
- `docs/development/workflow-automation-yida-benchmark-development-20260515.md`
- `docs/development/workflow-automation-yida-benchmark-verification-20260515.md`

### Phase 1：审批内核正确性

预计 7-10 天。

范围：

- 版本冻结与发布生命周期。
- 自动审批三合并：发起人合并、相邻审批人合并、历史审批人去重。
- 管理员跳转节点。
- 加签：前加签、后加签、并行加签。

验收：

- 修改模板后，旧实例仍按旧版本推进。
- 自动审批命中时写系统审计记录。
- stuck 审批实例可以由管理员跳转到合法目标节点。
- 加签任务能进入任务中心并正确回到原流程。
- 旧审批人不能在跳转或转交后继续处理失效任务。

### Phase 2：业务闭环 MVP

预计 5-8 天。

范围：

- `ApprovalAssigneeResolver` 第一版：static user、role、requester、form field user。
- 多维表/公开表单触发审批。
- 审批结果回写记录。
- 自动化新增 `start_approval` 动作。
- 审批完成事件桥：`approval.approved`、`approval.rejected`、`approval.returned`。

验收：

- 公开表单提交后自动生成审批。
- 审批完成后记录状态回写。
- 记录创建自动化可以发起审批。
- 审批完成可以触发自动化。
- 审批实例 metadata 保留 source snapshot。

### Phase 3：审批产品化增强

预计 5-8 天。

范围：

- 节点字段权限三态。
- 任务中心增强。
- 转交、退回、撤回、评论动作状态机补齐。
- 代理/委托中心第一版。
- 编辑器 dry-run 与 trace。

验收：

- 不同节点字段权限不同。
- 待办/已办/抄送/我发起列表一致。
- 退回、转交、撤回有审计记录。
- 代理任务能被代理人处理并保留 on-behalf-of 审计。
- dry-run 不写实例，但能展示路径和审批人解析结果。

### Phase 4：运行治理

预计 6-10 天。

范围：

- 自动化运行中心。
- 失败 execution 重跑。
- 异常通知和连续失败自动停用。
- 审批 SLA timeout actions 第一版：提醒、转交、跳转、自动同意、自动拒绝。
- 工作日历第一版：natural day、hour、minute，预留 business day。

验收：

- 自动化失败可以重跑。
- 支持包脱敏。
- SLA 到期能提醒、转交或自动处理。
- 运行中心能按失败状态过滤。
- 超时动作不会重复执行。

### Phase 5：可靠调度和工作日

预计 5-10 天。

范围：

- persistent automation jobs。
- full cron + timezone。
- misfire 策略。
- business calendar。
- 不计时时段。

验收：

- 重启不丢定时任务。
- 多副本不重复执行。
- 工作日/自然日/小时/分钟 SLA 规则可配置。

### Phase 6：高级流程设计器整合

预计 8-15 天。

范围：

- Workflow Designer 节点映射到审批/自动化 runtime。
- 节点 catalog 增加审批人、抄送、自动化动作、消息、数据操作。
- 测试运行 trace。
- BPMN runtime hardening。

验收：

- 设计器创建的流程能落到审批产品运行时。
- 测试运行可看到节点 trace。
- 高级 BPMN 仅承载已验证节点类型。

## 7. 开发顺序建议

优先顺序：

1. 版本冻结与发布生命周期。
2. 自动审批三合并。
3. 管理员跳转节点。
4. 加签。
5. `ApprovalAssigneeResolver`。
6. `approval_trigger_bindings`。
7. 审批结果回写多维表。
8. 自动化 `start_approval`。
9. 审批完成事件桥。
10. 任务中心增强。
11. 节点字段权限。
12. 自动化 execution retry。
13. SLA timeout actions。
14. 持久队列。
15. Workflow Designer runtime 映射。

原因：

- 1-4 来自 2026-05-14 对照文档的 Wave A，是内核正确性和运维兜底，应该先于新业务面。
- 5-9 形成宜搭式业务闭环，把多维表、公开表单、审批和自动化串起来。
- 10-11 是用户每天使用流程时最明显的产品体验差距。
- 12-13 解决运行治理和异常处理。
- 14-15 是平台化能力，必须建立在前面稳定语义上。

## 8. API 草案

### 8.1 审批触发绑定

```http
GET /api/approval-templates/:templateId/triggers
POST /api/approval-templates/:templateId/triggers
PATCH /api/approval-templates/:templateId/triggers/:bindingId
DELETE /api/approval-templates/:templateId/triggers/:bindingId
```

### 8.2 任务中心

```http
GET /api/approvals/tasks
GET /api/approvals/tasks/:taskId
POST /api/approvals/tasks/bulk-action
```

### 8.3 高级动作

```http
POST /api/approvals/:id/actions/transfer
POST /api/approvals/:id/actions/return
POST /api/approvals/:id/actions/revoke
POST /api/approvals/:id/actions/add-sign
POST /api/approvals/:id/actions/comment
POST /api/approvals/:id/jump
POST /api/workflow/instances/:id/jump
```

可以保留现有 `/api/approvals/:id/actions` 作为兼容入口，但新功能建议拆专用 endpoint，便于权限、参数和审计差异化。

### 8.4 自动化运行中心

```http
GET /api/multitable/automation-executions
GET /api/multitable/automation-executions/:executionId
POST /api/multitable/automation-executions/:executionId/retry
POST /api/multitable/automation-executions/:executionId/support-packet
```

### 8.5 模拟运行

```http
POST /api/workflow-designer/workflows/:id/simulate
POST /api/approval-templates/:id/simulate
```

## 9. 数据迁移草案

建议新增迁移按以下顺序拆小文件：

1. `create_approval_template_version_snapshots`
2. `add_approval_auto_approval_policy`
3. `extend_approval_records_for_jump_and_auto_approval`
4. `extend_approval_assignments_for_add_sign`
5. `create_approval_trigger_bindings`
6. `extend_approval_template_versions_for_assignee_sources`
7. `add_approval_node_field_permissions`
8. `create_approval_delegations`
9. `create_approval_deadlines`
10. `create_automation_execution_attempts`
11. `create_automation_jobs`

迁移原则：

- 不破坏现有 approval graph JSON。
- 新字段默认兼容旧模板。
- 所有新表带 `tenant_id`。
- 对外部副作用动作保留审计字段。
- JSONB 字段先灵活承载，稳定后再拆列。

## 10. 测试与验证计划

### 10.1 后端单元测试

建议新增：

- `approval-version-freeze.test.ts`
- `approval-auto-approval-policy.test.ts`
- `approval-admin-jump.test.ts`
- `approval-add-sign.test.ts`
- `approval-assignee-resolver.test.ts`
- `approval-trigger-binding.test.ts`
- `approval-node-field-permissions.test.ts`
- `approval-timeout-rules.test.ts`
- `automation-execution-retry.test.ts`
- `automation-start-approval-action.test.ts`

### 10.2 后端集成测试

建议新增：

- `approval-version-freeze-flow.test.ts`
- `approval-admin-jump-flow.test.ts`
- `approval-add-sign-flow.test.ts`
- `public-form-approval-trigger.test.ts`
- `multitable-record-approval-roundtrip.test.ts`
- `approval-task-center.test.ts`
- `automation-run-center.test.ts`

### 10.3 前端测试

建议新增：

- `approval-admin-jump.spec.ts`
- `approval-add-sign.spec.ts`
- `approval-trigger-settings.spec.ts`
- `approval-task-center.spec.ts`
- `approval-field-permissions.spec.ts`
- `multitable-automation-start-approval.spec.ts`
- `automation-run-center.spec.ts`

### 10.4 推荐命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-version-freeze.test.ts tests/unit/approval-auto-approval-policy.test.ts tests/unit/approval-admin-jump.test.ts tests/unit/approval-add-sign.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-assignee-resolver.test.ts tests/unit/approval-trigger-binding.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/approval-version-freeze-flow.test.ts tests/integration/approval-admin-jump-flow.test.ts tests/integration/approval-add-sign-flow.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-approval-trigger.test.ts
pnpm --filter @metasheet/web exec vitest run tests/approval-task-center.spec.ts tests/automation-run-center.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

在阶段结束前再跑：

```bash
pnpm lint
pnpm type-check
pnpm test
```

如环境允许，最终跑：

```bash
pnpm validate:all
```

## 11. 不建议当前阶段投入的内容

以下能力不是不重要，而是不适合在第一轮对标中先做：

- 完整 BPMN 2.0 兼容引擎。
- 任意脚本节点开放给业务用户。
- 外部连接器市场。
- 流程模板市场。
- 大屏分析平台。
- 复杂图形化自动化画布。

这些能力需要更强的沙箱、凭证管理、配额、审计、运行隔离和产品治理。建议等审批/自动化闭环稳定后再进入。

## 12. 当前仓库注意事项

当前工作区已有考勤/公式相关未提交改动。开展本方案开发前，应先隔离当前改动：

- 提交当前考勤/公式变更；或
- 暂存当前变更；或
- 使用独立 worktree/branch 开发流程自动化对标功能。

不要把考勤公式修复和流程/自动化对标开发混在同一个 PR。

## 13. 推荐第一张开发 TODO

结合 2026-05-14 对照文档后，第一张 TODO 不再直接从“公开表单触发审批”开始，而是先做审批内核最小闭环，避免后续业务闭环建立在会漂移的版本和任务语义上。

建议第一张 TODO：

1. 固化审批模板版本快照，确保实例发起后绑定不可变版本。
2. 新增自动审批三合并策略：发起人合并、相邻审批人合并、历史审批人去重。
3. 新增管理员跳转节点能力，支持 stuck 实例恢复。
4. 新增加签能力第一版：前加签、后加签、并行加签。
5. 补齐审计记录和时间线展示所需 metadata。
6. 增加后端单元和集成测试覆盖版本冻结、自动审批、跳转、加签。

这张 TODO 与旧文档 Wave A 对齐，属于“已上线模块内核打磨”，不新增独立产品面。完成后再进入第二张 TODO：公开表单/多维表触发审批、审批结果回写、`start_approval` 自动化动作。
