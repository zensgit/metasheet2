# 钉钉宜搭"流程设计"对照 MetaSheet V2 借鉴评估

**生成日期**：2026-05-14
**调研来源**：抓取 `docs.aliwork.com/docs/yida_support/_2/*` 共 9 个页面
**对照对象**：`packages/core-backend/src/workflow/*`、`packages/core-backend/src/multitable/automation-*`、`packages/core-backend/src/services/approval-bridge-*`、`packages/core-backend/src/routes/{workflow,workflow-designer,automation,approvals}.ts`
**阶段约束**：依据项目 memory K3 PoC 阶段一锁定，仅"已上线模块内核打磨"可以投入；新产品面（流程市场、分析看板、平台化产品）须等客户 GATE PASS

---

## 0. TL;DR（30 秒读完）

| 维度 | 结论 |
|---|---|
| 是否可以开展流程/自动化开发 | **可以**，且无须开新战线 |
| 推荐方向 | 直接打磨已交付的 3 个子系统：BPMN Engine / Multitable Automation / Approval Bridge |
| 头号借鉴点 Top 3 | ①自动审批 3 合并规则 ②超时 5 动作 + 工时日历 ③运行时跳转节点 + 加签 |
| 已具备但需补语义 | 流程版本冻结、子流程 callActivity 真执行、节点字段权限三态 |
| 阶段一锁外（暂不做） | 流程分析看板、节点上限护栏、模板市场 |

---

## 1. 宜搭流程能力全景（抓取材料归纳）

### 1.1 节点类型矩阵

| 节点类别 | 子类型 | 关键能力 |
|---|---|---|
| **发起节点** | — | 一流程一个，不可删除；发起人对表单字段权限可配 |
| **人工节点** | 审批人 | 同意/拒绝；多个候选人；可设"允许审批人为空" |
| | 执行人 | 不做决策，只执行后返回继续 |
| | 抄送人 | 只发消息提醒，不阻塞；权限为只读/隐藏二选一 |
| **分支节点** | 条件分支 | 满足规则的多个分支都会执行 |
| | 并行分支 | 多条线同时触发 |
| | 子流程 | 独立子流程；多种参数触发模式；解耦/组织复用 |
| **数据节点** | — | 与集成自动化共用的数据节点 |
| **脚本节点** | — | 开发者节点，写代码 |
| **消息节点** | 消息通知 | 钉钉工作通知/群通知 |
| | 邮件通知 | 邮件模板 |

**节点上限**：普通版 100 节点（含起止），专属版 150。超出报错且无法保存。

### 1.2 流程属性矩阵

#### 1.2.1 流程版本控制

- **三态**：设计中 / 启用中 / 历史
- **多草稿并行**：设计态可同时存在多个
- **版本不可逆**：启用中版本只能查看，无法直接修改；历史版本可"再次发布"
- **数据保护**：流程修改对历史数据**不生效**——版本号变更后，旧规则只作用于该版本下已提交的数据
- **生命周期约束**：含有未完结实例的历史版本无法删除
- **版本日志**：版本号、备注、创建人/时间、更新人/时间

#### 1.2.2 权限设置

| 维度 | 配置项 |
|---|---|
| 发起权限 | 谁能发起 + 发起页字段权限 |
| 节点字段权限 | 审批/执行：**可编辑/只读/隐藏 三态**；抄送：只读/隐藏 二态 |
| 全局查看态权限 | 默认查看态字段权限 |

#### 1.2.3 自动审批规则

三种内置策略（节点级 + 全局级，**节点级优先**）：

1. **所有发起人合并**：审批/执行节点指向当前发起人时自动通过
2. **相邻审批人合并**：与上一节点人员一致时自动通过（"相邻"指设计图上相邻，**抄送不占份额**）
3. **审批人自动去重**：流程中已审批过的人，后续节点自动通过

#### 1.2.4 超时处理规则（专业版+）

- **5 种执行动作**
  - 自动提醒（钉钉工作通知 + 待办消息）
  - 自动转交（指定成员/字段成员/直属主管）
  - 自动跳转（流程内其他节点）
  - 自动同意（审批人专享）
  - 自动拒绝（审批人专享）
- **4 种时间维度**
  - 法定工作日（去掉节假日 + 双休）：1-31 天
  - 自然日：1-31 天
  - 小时：1-744 小时（可设时间段）
  - 分钟：10-44640 分钟
- **不计时时间段**（仅全局可设，节点级开关）
  - 按"星期 + 时间段"组合
  - 例：每天 0-9 点、12-13 点、18-24 点不计时
- **重复提醒**：默认 1 次，最高 10 次
- **特殊语义**
  - 转交时直属主管不存在→**终止转交**
  - 超时规则对**历史数据不生效**

#### 1.2.5 节点提交规则

| 维度 | 选项 |
|---|---|
| 适用节点 | 开始节点 / 结束节点（同意/拒绝/撤销 三动作分别配）/ 流程中审批节点 |
| 触发方式 | 任务完成执行（同意/拒绝/保存/退回 + 校验或关联）/ 节点完成执行（同意/拒绝 + 关联） |
| 规则类型 | **校验规则**（可阻断当前操作）/ **关联操作**（不阻断，跑业务公式更新其他表） |

文档中明确：**复杂的业务关联推荐用集成自动化（有画布视图）**——宜搭已经把"流程内联公式"和"集成自动化"做了分工。

#### 1.2.6 手写签名

- 仅适用于审批/执行人节点
- **移动端**预设个人签字；PC 端需要扫码
- 首次签字后默认沿用
- 节点级开关 + 全局设置

### 1.3 运营 & 实例语义

- **流程任务中心**：个人代办的跨流程聚合
- **代理中心**：代理别人审批
- **流程分析**：内置数据集 + 报表，可下钻；默认本表过滤
- **测试**：编辑器内"测试"按钮 → 启动测试 → trace 出来
- **跳转节点**：异常时（如审批人离职）管理员**手工跳转**到任意节点，恢复 stuck 流程

### 1.4 实例约束（很重要的设计意图）

| 约束 | 说明 |
|---|---|
| **发起时刻冻结** | 发起人和发起部门在发起时刻已确定，后续部门调整不影响 |
| **离职/调岗保护** | 流程发起后人员变动不影响发起态信息，但若审批节点依赖离职人的组织信息（如主管），流程会报错 → 用跳转节点解决 |
| **消息模板需重刻版本** | 改了消息模板不会立即生效，要点"生成新版本" |
| **关闭通知粒度** | "关闭移动端提交通知审批人"是组织维度，不可单流程关 |

---

## 2. MetaSheet V2 现状代码地图

### 2.1 BPMN Engine 子系统

**文件**：`packages/core-backend/src/workflow/`
- `BPMNWorkflowEngine.ts` 1852 行
- `WorkflowDesigner.ts` 924 行
- `workflowDesignerDrafts.ts` / `workflowDesignerRouteModels.ts` / `workflowHubTeamViews.ts`

**已实现的节点类型**（`BPMNWorkflowEngine.ts:341-369` switch case）：

| 我方节点 | 对应宜搭 | 缺口 |
|---|---|---|
| startEvent | 发起节点 | 无"发起人字段权限"维度 |
| endEvent | 结束节点 | 无"按节点动作分别配规则" |
| userTask | 审批人/执行人 | **不区分"审批"vs"执行"**；无字段权限三态；无"允许为空" |
| serviceTask | 数据节点的部分能力 | 通用 service 而非数据写入定向 |
| scriptTask | 脚本节点 | 已有 `child_process` 等危险模式拦截 |
| exclusiveGateway | 条件分支 | OK |
| parallelGateway | 并行分支 | OK |
| intermediateCatchEvent | 计时/消息/信号 | 计时器走自然时间，无工时日历 |

**未实现但已在 BPMN names 列表里露脸**（`BPMNWorkflowEngine.ts:924-925`）：
- `bpmn:callActivity` / `bpmn:subProcess` — **stub，无 case 执行**

**完全缺失**：
- 抄送节点（cc 是 approval tab 视图，不是流程节点）
- 邮件通知节点（要走 serviceTask 自实现）
- 钉钉消息节点（已在 multitable automation 实现，未挂到 BPMN）

**运行时操作**：
- `deployProcess` / `startProcess` / `executeActivity`
- `completeUserTask` / `sendMessage` / `broadcastSignal`
- incidents 解决 / shutdown

### 2.2 Multitable Automation 子系统

**文件**：`packages/core-backend/src/multitable/automation-*.ts`（合计 7458 行）

**Triggers (7 种)** `automation-triggers.ts`：
- record.created / record.updated / record.deleted
- field.value_changed（支持 any / equals / changed_to）
- schedule.cron / schedule.interval
- webhook.received

**Actions (8 种)** `automation-actions.ts`：
- update_record / create_record
- send_webhook
- send_notification（站内通知）
- send_email
- send_dingtalk_group_message / send_dingtalk_person_message
- lock_record

**Conditions** `automation-conditions.ts`：
- 12 个 operator：equals, not_equals, contains, not_contains, greater_than, less_than, greater_or_equal, less_or_equal, is_empty, is_not_empty, in, not_in
- AND/OR 嵌套，最大 5 层
- 按字段类型 allow-list（数值/文本/多选等使用不同 operator 子集）

**调度与可观测性**：
- `automation-scheduler.ts`：Redis Leader Lock + Prometheus gauge
- `automation-log-service.ts`：日志写入
- `automation-log-redact.ts` + `automation-log-support-packet.ts`：日志脱敏 & 支持包

### 2.3 Approval Bridge 子系统

**文件**：`packages/core-backend/src/services/approval-bridge-types.ts` + `routes/approvals.ts` + `routes/approval-history.ts` + `routes/approval-metrics.ts`

**Actions (6 种)** `approval-bridge-types.ts:115`：
- approve / reject / transfer / revoke / comment / return

**已具备**：
- SLA hours（`req.body.slaHours`）+ breach notifier（`approval-sla-scheduler` + `approval-breach-notifier`）
- 平行区域：`currentNodeKeys` 长度 ≥ 2 表示并行（`approval-bridge-types.ts:34`）
- 视图 tabs：pending / mine / cc / completed（`routes/approvals.ts:493`）
- 桥接：PLM Approval Bridge / After-Sales Approval Bridge
- breach_notified_at 字段防止重复通知

**完全缺失**：
- 自动审批合并规则
- 跳转节点
- 加签
- 工时日历
- 节点字段权限三态
- 流程实例发起时刻冻结的语义验证

### 2.4 Workflow Designer 子系统

**文件**：`packages/core-backend/src/routes/workflow-designer.ts`（21 路由）+ `workflow/WorkflowDesigner.ts`

**已具备**：
- 节点 catalog `GET /node-types` → 8 个 builtin + `workflow_node_library` 自定义节点
- 版本字段 `version: number`（`workflowDesignerDrafts.ts:40,52`）
- drafts 表 + drafts 路由
- 模板 `templates` API
- Team-level Hub views

**缺失**：
- 个人任务中心
- 模拟测试（编辑器一键 dry-run）
- 流程实例版本冻结语义

---

## 3. 能力差矩阵（逐项比对）

> 标注：✅=已具备且对齐；🟡=部分支持/需扩展；❌=完全缺失

| 维度 | 子项 | 宜搭 | MetaSheet | 差距说明 |
|---|---|---|---|---|
| **节点** | 发起节点字段权限 | ✅ | ❌ | userTask 无 fieldPermissions |
| | 审批 vs 执行 区分 | ✅ | ❌ | 全部归 userTask |
| | 抄送节点（流程内非阻塞）| ✅ | 🟡 | cc 仅为视图 tab |
| | 子流程（callActivity）| ✅ | 🟡 | BPMN names 列了但 case 未实现 |
| | 数据节点（写入定向）| ✅ | 🟡 | 用 multitable automation 替代但未挂 BPMN |
| | 消息/邮件 作为节点 | ✅ | 🟡 | multitable automation 已有 action，未挂 BPMN |
| | 节点上限护栏 | ✅ 100/150 | ❌ | 无显式上限校验 |
| **权限** | 节点字段权限三态 | ✅ | ❌ | — |
| | 发起权限白名单 | ✅ | 🟡 | RBAC 层有但未流程化 |
| **版本** | 设计中/启用中/历史 | ✅ | 🟡 | version int 有但状态机不完整 |
| | 多草稿并行 | ✅ | 🟡 | drafts 表存在但生命周期未规范 |
| | 历史实例冻结 | ✅ | ❌ | 没看到 instance.definitionVersion 不变的语义 |
| | 含未完结实例的版本不可删 | ✅ | ❌ | — |
| **自动审批** | 发起人合并 | ✅ | ❌ | — |
| | 相邻审批人合并 | ✅ | ❌ | — |
| | 审批人去重 | ✅ | ❌ | — |
| | 全局 vs 节点级优先 | ✅ | ❌ | — |
| **超时** | 5 种执行动作 | ✅ | 🟡 | 当前仅"提醒"（breach-notifier），缺转交/跳转/同意/拒绝 |
| | 4 种时间维度 | ✅ | 🟡 | 仅 hours 单维 |
| | 不计时时间段 | ✅ | ❌ | — |
| | 重复提醒最多 10 次 | ✅ | 🟡 | breach_notified_at 但缺次数上限 |
| | 法定节假日 / 工时日历 | ✅ | 🟡 | DB 已有 `attendance_holidays` + `is_workday` 但未接入 SLA |
| **提交规则** | 校验规则 | ✅ | 🟡 | 用 exclusiveGateway condition 替代 |
| | 关联操作（同步写别表）| ✅ | 🟡 | multitable automation 有 action 但未在审批完成时回调 |
| | 触发方式细分 | ✅ | ❌ | 无"任务完成 vs 节点完成"区分 |
| **签名** | 手写签名 | ✅ | ❌ | 国内合规缺项 |
| **运营** | 跳转节点（管理员手工）| ✅ | ❌ | 流程 stuck 只能改 DB |
| | 加签 | (常规 ISV 标配) | ❌ | — |
| | 代理审批 | ✅ | ❌ | — |
| | 个人任务中心 | ✅ | 🟡 | workflowHubTeamViews 仅 team 级 |
| | 流程分析看板 | ✅ | ❌ | 阶段三再说 |
| | 编辑器模拟测试 | ✅ | ❌ | 无 dry-run 端点 |
| **实例语义** | 发起时刻冻结部门 | ✅ | 🟡 | 部门字段存了但无显式锁定语义 |
| | 模板改完要重刻版本 | ✅ | ❌ | 当前应该会立即生效，可能有"幽灵更新" |

---

## 4. 借鉴清单（按 ROI / 阶段一锁兼容度排序）

### 4.1 🟢 阶段一锁兼容（"已上线模块内核打磨"，可直接立项）

---

#### #1 自动审批 3 合并规则

**ROI**：⭐⭐⭐⭐⭐（客户最常吐槽点）
**预估工时**：2-3 天

**现状缺口**：
- `approval-bridge` 在分配节点 assignee 后直接进入待审状态
- 同一人重复审批 / 发起人审批自己等场景没自动跳过

**落地方案**：
1. `approval-bridge-types.ts` 增 `AutoApprovalPolicy`：
   ```ts
   interface AutoApprovalPolicy {
     mergeWithInitiator?: boolean
     mergeAdjacent?: boolean        // 抄送不占份额
     dedupApprovers?: boolean
     scope?: 'rule' | 'global'      // rule 优先于 global
   }
   ```
2. 在分配 assignee 前调用 `applyAutoApprovalRules(approval, policy, history)`：
   - 命中 → 自动 approve + 写历史（action='approve', actor=system, reason=auto_merged_initiator|adjacent|dedup）
3. 全局策略读 `org_settings.approval_auto_policy`；规则级覆盖全局

**测试**：
- `approval-graph-executor.test.ts` 加 3 case（每条规则一个）
- 边界：抄送不占相邻份额；多条规则并存的优先级

**风险**：
- 自动批必须有审计日志区分人工/系统
- 客户可能要求"自动审批人记为发起人"vs"系统账号"——做成可配置

---

#### #2 超时 5 动作 + 工时日历一体化

**ROI**：⭐⭐⭐⭐⭐（运营效率核心）
**预估工时**：4-5 天

**现状缺口**：
- `approval-sla-scheduler` + `approval-breach-notifier` 仅做"提醒"，缺自动转交/跳转/同意/拒绝
- SLA 计算走自然时间，未利用已存在的 `attendance_holidays` / `is_workday` 表
- 无"不计时时间段"机制
- breach 重复提醒次数无上限

**落地方案**：

A. **BusinessCalendarService 抽取**（新建 `services/BusinessCalendarService.ts`）：
   - 复用 `attendance_holidays`（org_id, holiday_date）
   - 复用排班表的 is_workday 标识
   - 提供 `nextBusinessTime(from, durationSpec)` API：支持 `{ unit: 'workday'|'natural_day'|'hour'|'minute', amount: int, businessHours?: {start,end}, blackouts?: [{dayOfWeek, ranges}] }`
   - 节假日数据**复用** attendance 模块（避免"两套节假日"）

B. **SLA 计算改造**：
   - `approval-sla-scheduler` 把 due 时间通过 BusinessCalendarService 算出
   - schema 加 `sla_unit`（workday/natural_day/hour/minute）、`sla_skip_ranges`（不计时时间段 JSON）

C. **超时动作扩展**：
   ```ts
   type BreachAction =
     | { kind: 'remind', recipients: ApproverSelector, template: string }
     | { kind: 'transfer', target: ApproverSelector }
     | { kind: 'jump', toNodeKey: string }
     | { kind: 'auto_approve', reason: string }
     | { kind: 'auto_reject', reason: string }
   ```
   `breach-notifier` 改为分发器，按 action.kind 调用 approval-bridge 对应方法

D. **重复提醒次数**：
   - 表加 `breach_remind_count`
   - 配置中 `maxReminders`（默认 1，上限 10）
   - 超过则停止；命中 transfer/jump/auto_* 后停止

**测试**：
- `approval-sla-scheduler.test.ts` 加 4 case（4 种时间维度）+ 4 case（5 动作除提醒外的 4 种）+ 不计时时间段命中/非命中
- 边界：自动转交时主管不存在 → 行为对齐宜搭"终止转交"
- 工时日历回归：原有用 hour 计算的旧 SLA 必须无破坏（迁移期默认 sla_unit='hour'）

**风险**：
- auto_approve / auto_reject 必须接 RBAC：流程定义里**显式允许**才生效（默认拒绝），避免静默批准
- 与历史数据交互：宜搭"超时规则对历史数据不生效"，我方需要在 instance.definitionVersion 锁定后才能正确执行（依赖 #6）

---

#### #3 跳转节点（admin jump）

**ROI**：⭐⭐⭐⭐（运维兜底刚需）
**预估工时**：3 天

**现状缺口**：
- 审批人离职 + 主管字段为空 → 流程 stuck
- 唯一解法是改 DB 或 transfer，但 transfer 需要一个具体人，找不到时无解

**落地方案**：
1. BPMN engine 加 `jumpToActivity(instanceId, targetActivityId, reason, actorId)`：
   - 校验：actor 必须有 `workflow:admin_jump` 权限
   - 校验：targetActivityId 在当前 process definition 内且非已完成的端点
   - 完成当前 activity（标记 `outcome='admin_jump'`）+ 启动 target activity
   - 写审计日志 + 发起事件 `workflow.admin_jumped`
2. Approval bridge 镜像 `adminJump(approvalId, toNodeKey, reason)`：
   - 关闭当前 assignments
   - 创建 target 节点的 assignments
3. `POST /api/workflow/instances/:id/jump` + `POST /api/approvals/:id/jump`

**测试**：
- BPMN engine 单测：跳转后流程 token 正确
- 安全：无权限调用 → 403
- 历史完整性：jump 记录必须在 instance.history 可见

**风险**：
- 必须有严格审计 + 同步发钉钉通知所有审批人
- 不允许跳到已通过的节点（防回退混乱）；如要回退用 return action

---

#### #4 加签（运行时追加审批人）

**ROI**：⭐⭐⭐⭐（国内审批刚需）
**预估工时**：3-4 天

**现状缺口**：
- 当前 assignee 在节点配置时固定，运行时无法追加

**落地方案**：
1. Approval bridge 加 `addAssignee(approvalId, userId, mode, actorId)`：
   ```ts
   type CountersignMode =
     | 'before'    // 我审之前先让某某审
     | 'after'     // 我审之后再让某某审
     | 'parallel'  // 与我同时审，全部通过才推进
   ```
2. Schema：`approval_assignments` 加 `countersign_origin`（actorId）+ `countersign_mode`
3. 进入下一节点的条件改造：
   - parallel：当前节点所有 assignments 完成
   - before：新追加的 assignment 完成后回到原 assignee
   - after：原 assignee 完成后才轮到追加的
4. 历史中明确标注"XX 因为 YY 被 ZZ 加签"

**测试**：
- `approval-graph-executor.test.ts` 加 3 case（3 种 mode）
- 边界：加签人不能是发起人 / 不能是已完成节点的审批人
- 与平行区域并存

**风险**：
- 加签人必须有 `approvals:countersign` 权限
- 与自动合并规则的交互（加签人=发起人时是否自动通过？应该不自动，因为加签是显式意图）

---

#### #5 节点字段权限三态

**ROI**：⭐⭐⭐（数据脱敏 + 流程合规）
**预估工时**：4-5 天（前后端都要改）

**现状缺口**：
- BPMN userTask 只配 assignee/candidateUsers/formKey，无字段级权限
- 多维表已经有 field permission engine，但未挂流程

**落地方案**：
1. NodeTypeDefinition.properties 加 `fieldPermissions: { type: 'object', label: 'Field Permissions' }`
2. 节点配置 schema：
   ```ts
   interface NodeFieldPermissions {
     [fieldId: string]: 'edit' | 'readonly' | 'hidden'
   }
   ```
3. 完成节点表单加载时（`completeUserTask` 前），读当前节点的 fieldPermissions
4. 前端表单引擎按权限渲染
5. 后端 `completeUserTask` 校验提交字段必须在 edit 范围内

**测试**：
- 单测：edit 字段可提交、readonly 字段提交被拒、hidden 字段不在返回 form schema
- 集成测：从 startEvent 流到 userTask，字段权限按节点切换

**风险**：
- 与现有多维表字段权限引擎不冲突（应该是叠加优先 hidden）
- 性能：大量字段时的 schema 计算

---

#### #6 流程版本冻结语义

**ROI**：⭐⭐⭐⭐（数据正确性根基）
**预估工时**：2-3 天

**现状缺口**：
- 我方有 `version: number` 字段但缺"实例发起后锁定 definitionVersion，后续 publish 不影响"的明确语义
- 直接后果：改了流程定义可能把正在跑的实例也变了

**落地方案**：
1. `workflow_instance` 表加 `definition_version: int NOT NULL`（迁移：默认设当前 version）
2. `startProcess` 时记录 `definition_version`
3. `executeActivity` 加载 definition 时用 `definitionId + definitionVersion` 而非最新版
4. 加 `workflow_definition_versions` 历史表：
   ```sql
   create table workflow_definition_versions (
     definition_id text,
     version int,
     definition_json jsonb,
     state text,            -- 'design' | 'active' | 'history'
     created_at, created_by, ...
     primary key (definition_id, version)
   )
   ```
5. publish 流程：当前 active → history，新版本 → active
6. 删除约束：状态=history 且无 instance.definition_version 引用 → 才可删

**测试**：
- 单测：实例发起后修改 definition，旧实例继续按旧版执行
- 边界：尝试删除有未完结实例的 history 版本 → 拒绝

**风险**：
- 现有运行中实例的迁移（赋默认版本）

---

#### #7 编辑器模拟测试（dry-run）

**ROI**：⭐⭐⭐⭐（设计效率倍增器）
**预估工时**：3-4 天

**现状缺口**：
- 设计完流程必须真启动一个实例才能看分支走向
- `routes/workflow-designer.ts` 21 个端点里没有 `test` 类

**落地方案**：
1. `POST /api/workflow-designer/:definitionId/simulate`：
   ```ts
   { startVariables: Record<string, unknown>, autoCompleteUserTasks?: boolean }
   → { trace: ActivityTrace[], finalState: 'completed'|'stuck'|'rejected' }
   ```
2. `WorkflowDesigner.simulate(def, vars)`：
   - 用一个 in-memory 引擎跑 definition（不写库）
   - 用户任务可选自动通过（用于查看分支走向）/ 暂停（用于查看到达哪个节点）
   - 输出每个 activity 的 input/output/duration/path

3. 前端编辑器顶部"测试"按钮 → 模态：填变量 → 看 trace 高亮

**测试**：
- 单测：给定 definition + variables 输出 trace
- 不影响真实运行实例
- 失败原因可读（缺变量、条件无分支命中、达到上限）

**风险**：
- 用户任务的"自动通过"语义需要明确（区分模拟人为同意 vs 自动审批）

---

### 4.2 🟡 阶段一锁内 borderline（属于已上线模块但工作量大或边界模糊）

---

#### #8 个人任务中心

**ROI**：⭐⭐⭐
**预估工时**：3 天

**落地方案**：
- `GET /api/workflow/me/tasks?status=pending`：聚合 `bpmn_user_tasks` 中 assignee=me 的 + `approval_assignments` 中 actor=me 的
- 视图层在 web 端做一个"我的待办"页（mock：`workflowHubTeamViews` 拷一份做 personal）

---

#### #9 代理中心

**ROI**：⭐⭐
**预估工时**：3-4 天

**落地方案**：
- 表 `approval_delegations(user_id, delegate_to, start_at, end_at, scopes jsonb)`
- approval bridge 解析 assignee 时插一层 lookup：若 user_id 有有效代理，则 assignment 同时发给原人和代理人，二者任一处理即可
- BPMN userTask 同理

---

#### #10 节点提交·关联操作

**ROI**：⭐⭐⭐（已经有 multitable automation action 可复用）
**预估工时**：2 天

**落地方案**：
- approval bridge 在 `approve` / `reject` / `return` 完成后发送 EventBus 事件 `approval.<action>.completed`
- multitable automation 加 trigger type：`approval.completed`（subtype：approved/rejected/returned）
- 配置端：在节点配置上挂"完成后触发的 automation rule"

**收益**：节点完成时跑业务公式更新别表的需求**已经被 multitable automation 覆盖**，只缺 trigger 桥。

---

#### #11 子流程 callActivity 真实执行

**ROI**：⭐⭐⭐
**预估工时**：4-5 天

**落地方案**：
1. `BPMNWorkflowEngine.executeActivity` switch 加 case `callActivity` / `subProcess`：
   - 加载被调用的 definition
   - startProcess 一个子实例，记录 `parent_instance_id` / `parent_activity_id`
   - 父实例进入等待
   - 子实例 endEvent 时回写 output variables 到父实例 + 唤醒父 activity
2. 变量传递：节点配置 inputMapping / outputMapping
3. 错误传播：子流程异常 → 父流程 incident

**测试**：
- 父子嵌套 2 层、3 层
- 子流程异常被父流程捕获
- 变量映射

---

#### #12 抄送独立节点

**ROI**：⭐⭐
**预估工时**：2 天

**落地方案**：
- 加 BPMN 节点类型 `ccTask`（非阻塞，发完消息立即通过）
- 复用 multitable automation 的 `send_dingtalk_*` action 作为执行体

---

#### #13 手写签名

**ROI**：⭐⭐（合规客户必需）
**预估工时**：3-4 天

**落地方案**：
- 新建 SignatureService：管理用户预设签字图（OSS 存储）
- userTask 加 `requireSignature: boolean`
- completeUserTask 时校验 signatureRefId 存在
- 前端 mobile 实现 canvas 签字 + 上传

---

### 4.3 🔴 阶段一锁外（要等 K3 PoC GATE PASS）

| # | 项目 | 阻塞原因 |
|---|---|---|
| 14 | 流程分析数据集 + 看板 | 新产品面（BI 视图层），属阶段三平台化基建 |
| 15 | 设计器节点上限护栏 100/150 | 设计器层规则；目前没有用户压力，不急 |
| 16 | 流程模板市场化 | 阶段四 Marketplace 范畴 |
| 17 | 多语言流程定义（i18n on rule name） | 平台化能力，等阶段二 |

---

## 5. 推荐路线图

### Wave A（2 周窗口，约 14 工作日）

| 顺序 | 项 | 估时 | 依赖 |
|---|---|---|---|
| 1 | #6 流程版本冻结语义 | 2-3 天 | 无（是其他改动的前提） |
| 2 | #1 自动审批 3 合并规则 | 2-3 天 | #6 |
| 3 | #3 跳转节点 + #4 加签 | 6-7 天 | #6 |

**理由**：
- #6 是底座，先稳住数据正确性
- #1/#3/#4 直接对外可感、风险低
- Wave A 完成可对外宣称"V2 审批引擎升级"

### Wave B（2 周窗口，约 14 工作日）

| 顺序 | 项 | 估时 |
|---|---|---|
| 4 | #2 超时 5 动作 + 工时日历 | 4-5 天 |
| 5 | #7 编辑器模拟测试 | 3-4 天 |
| 6 | #5 节点字段权限三态 | 4-5 天 |

### Wave C（机动队列，按客户压力调度）

- #8 个人任务中心（3 天）
- #9 代理中心（3-4 天）
- #10 节点提交关联操作（2 天）
- #11 子流程 callActivity（4-5 天）
- #12 抄送独立节点（2 天）
- #13 手写签名（3-4 天）

---

## 6. 阶段一锁兼容性自检

✅ 全部 13 个借鉴点都**不触碰** `plugins/plugin-integration-core/*`
✅ 全部 13 个借鉴点都**不开新产品面**（BPMN engine / approval-bridge / multitable automation 都是已交付模块）
✅ 全部 13 个借鉴点**不动 K3 PoC 路径**（`lib/adapters/k3-wise-*.cjs` 无变更）
✅ 工时日历复用现有 `attendance_holidays` 表，不引入新基础设施
🟡 Wave A / B 体量较大，建议每个 wave 切独立分支并按 4-lane 策略走 contracts → runtime → frontend → integration

---

## 7. 设计借鉴的"反面"（哪些不要照抄）

宜搭的某些约束源于 SaaS 多租户 + 极致简化，我方不一定需要：

| 宜搭做法 | 不建议照抄的理由 |
|---|---|
| 节点上限 100/150 | 我方私有部署场景，客户可能需要更多；做成可配置阈值即可 |
| 关闭通知是组织维度 | 我方 RBAC 体系更细，建议做成 流程级/角色级 双层 |
| 关闭通知功能要"提交工单 3 工作日" | 这是 SaaS 工单流程，我方私有部署直接给管理员开关 |
| 仅移动端手写签名 | PC 端如果有触控屏可以支持，没必要锁死 |
| "测试版本"无独立环境 | 我方可借助 `definition_version` + state='design' 隔离，避免污染生产 |

---

## 8. 抓取页面索引（用于回溯）

| 主题 | URL | 用途 |
|---|---|---|
| 流程简介 | `/docs/yida_support/_2/crwfii` | 总览、节点上限、常见问题 |
| 快速开始 | `/docs/yida_support/_2/qgaxvq` | 请假流程实例 |
| 流程节点介绍 | `/docs/yida_support/_2/trbqg6` | 7 类节点定义 |
| 流程属性设置 | `/docs/yida_support/_2/ef8e88` | 6 个子页索引 |
| 流程版本控制 | `/docs/yida_support/_2/ef8e88/daeh3v` | 三态、多草稿、回退 |
| 权限设置 | `/docs/yida_support/_2/ef8e88/lagbfd` | 三态字段权限 |
| 自动审批规则 | `/docs/yida_support/_2/ef8e88/eeykw4` | 3 种合并 |
| 超时处理规则 | `/docs/yida_support/_2/ef8e88/aglbg3` | 5 动作 × 4 维度 × 不计时段 |
| 节点提交规则 | `/docs/yida_support/_2/ef8e88/emt041` | 校验 vs 关联 |
| 手写签名 | `/docs/yida_support/_2/ef8e88/ezdklv` | 移动端签字 |
| 流程案例 | `/docs/yida_support/_2/bpnetv` | 13 个 ISV 常见场景列表 |

---

## 9. 下一步动作建议

1. **不立项前**：把当前分支 `codex/data-factory-issue1542-postdeploy-smoke-20260515` 上 8 个未提交改动 + 13 个 `.tmp-*.mjs` 脚本归类整理（stash / 落分支 / 删除）
2. **立项时**：从 main 切出 `flow/wave-a-approval-kernel-20260515`，按 4-lane 策略推 Wave A 三项
3. **每完成一项**：单独 PR + 单测覆盖 + 升级 CHANGELOG
4. **Wave A 完成后**：写一份"V2 审批引擎升级 Release Note"对外说明

---

*文档结束。本评估基于 2026-05-14 当日代码快照，如代码后续演进请重新比对。*
