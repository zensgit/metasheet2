# 多维表 × 审批流程结合 —— 合成设计文档

- 日期:2026-09-15(合成于 2026-09-14 晚)
- 基线:main @ e89f3e15e(事实排查基线);origin/main c6f2d437a 时未重新核行号,行号以 e89f3e15e 为准
- 来源:三份设计(产品设计 / 平台架构 / 风险治理)+ 两位评审的评分与嫁接/否决意见 + 本轮 4 项抽查核实
- 本文所有路径相对 `C:/Users/zhou/Downloads/dev/metasheet/`;`services/` = `packages/core-backend/src/services/`,`multitable/` = `packages/core-backend/src/multitable/`,`routes/` = `packages/core-backend/src/routes/`,`web/` = `apps/web/src/`
- 标注约定:【已有】代码里已存在且已核实;【缺口】需要开发;【待核实】设计基于其为真但本轮未查证,上线前必查

---

## 0 一句话结论

审批引擎、审批中心、自动化→审批→回写的后台管线都已完整,**缺的只是多维表这一侧「记录 ↔ 审批实例」的一等关联与一线入口**;因此不重造任何引擎,第一期只用现有 `start_approval` + `approval.completed` 配规则闭环(零开发或一个小 PR),第二期在多维表侧加一张 `multitable_record_approvals` 关联表 + 薄的 `RecordApprovalService` 两阶段发起 + 记录「审批」tab 与双向回链,第三期做批量/按钮/预设治理与系统锁;**在任何一线入口上线之前必须先关掉遗留 `POST /api/approvals/:id/approve|reject` 对模板运行时实例的裸终结**,否则记录侧状态会永远停在「审批中」。

---

## 1 现状

### 1.1 已有能力(不重做)

| 能力 | 位置 | 备注 |
|---|---|---|
| 审批模板中心 + 表单 Schema(14 种字段含 `record-link`)+ Canvas V2 画布(7 种节点)+ 发布定版 | `services/ApprovalProductService.ts`(12431 行,`class` :5291);字段类型 `types/approval-product.ts:178-211`;`record-link` props 钉死 `baseId/sheetId` :1382-1403;发布冻结 `runtime_graph`,实例读自己的 `published_definition_id`(dispatchAction :9541-9546) | 【已有】 |
| 程序化发起入口 | HTTP `POST /api/approvals`(`routes/approvals.ts:1415`,`approvals:write`);服务函数 `createApproval(request, actor)`(:7868);路线预演 `POST /api/approval-templates/:id/route-preview`(:644 → `previewApprovalRoute` :7730) | 【已有】`createApproval` 在 :7900 附近自行 `pool.connect()` + `BEGIN`,**不接受外部事务**(本轮核实) |
| 实例运行时九个动作动词 | `dispatchAction`(:9511);座位闸 :9621(除 `revoke` 外必须有活跃 assignment);`revoke` 规则 :10158-10229(仅发起人 / `allowRevoke` / 窗口) | 【已有】 |
| 完成事件 `ApprovalCompletionEventV1` | `services/ApprovalCompletionEvent.ts:45-67`;8 个发布点成对(outbox + post-commit emit);`durable` 开时 emit 直接 return 改走 outbox(:124) | 【已有】`transition.toVersion` 可做单调幂等 |
| 任务事件 `ApprovalTaskCreatedEventV1` | `services/ApprovalTaskCreatedEvent.ts:43-63`;eventId 含 `instanceId:nodeKey:entryEpoch:assigneeUserId` | 【已有】载荷是否含 `nodeKey` 字段名【待核实】 |
| 自动化 → 审批(W6-1) | `multitable/automation-approval-bridge-service.ts:225` `startApproval`:幂等键 `start_approval:{rootExecutionId}:{stepIndex}:{templateId}`(:237)、发起人解析 `loadAuthorizedActor`(:458-513,必须 active 且 isAdmin 或持 `approvals:write`)、`formDataMapping` 渲染(:154-178)、桥行落 `sheetId/recordId`(:265-267)、挂起 job、完成后可重入租约(:360-433,最多 8 次,死信) | 【已有】强制 `execution_mode='workflow_job_v1'` |
| 审批结果回写(W7) | `multitable/automation-service.ts:368-420` 保存期校验、:3318-3363 同库写回、:3365-3430 跨库、:3466-3540 `applyResultWritebackPatch`(写 `meta_record_revisions` source='approval' + realtime) | 【已有】非 approved 需显式 `onNonApproved:true`(:3335);`StartApprovalConfig` 类型里**没有** `resultWriteback`(`automation-actions.ts:221-234` 与实现分叉) |
| 审批 → 自动化(T1-3 / A-2a) | 触发器 `approval.completed`(`automation-service.ts:209,217,1092-1107`)与 `approval.task_created`(:1111-1121);动作白名单 :219-232(通知族 + FWB)与 :262-265(通知族 + 钉钉卡片);`outcomes` 缺省降级为 `['approved']`(:284-290) | 【已有】record-less:`recordId:''`、`data:{}`(:3205-3217),不允许 conditions |
| 表单值回写 FWB | `multitable/approval-fwb-*.ts`;执行器 `automation-executor.ts:3623-3707`;flag `APPROVAL_FWB_WRITEBACK_ENABLED` 默认 OFF;硬依赖 `AUTOMATION_DURABLE_DELIVERY_ENABLED=true` | 【已有】只在 `approved` 时执行 |
| 只读投影 | `multitable/approval-record-projection-service.ts`(:88-100 十列,无来源记录 id;事件静默;按 version 幂等) | 【已有】admin-only 围栏 |
| 通用记录锁 | `meta_records.locked/locked_by/locked_at`;`multitable/record-lock.ts:44-58` `canEditWhileLocked` 仅 `locked_by`/`created_by`;`lock_record` 自动化动作;检查器锁横幅 `web/multitable/components/MetaRecordInspector.vue:243-252` | 【已有】与审批实例零绑定 |
| 多维表记录深链 | `web/router/multitableRoute.ts:37` 解析 `route.query.recordId`(评论深链在用) | 【已有】本轮核实;两份设计里的「待核实」可划掉 |
| 审批中心前台 | `web/router/appRoutes.ts:345-427`;`web/views/approval/*.vue`;API 封装 `web/approvals/api.ts` | 【已有】本轮核实 `api.ts` 无对遗留 `/approve`、`/reject` 路径的直调 |
| 钉钉侧 | 互动卡片投递(`approval.task_created` → `send_dingtalk_approval_card`)+ 卡片决策 ledger-only(`services/ApprovalCardDeliveryAction.ts`)+ Stream 回调 approve-only + 工作通知 | 【已有】无钉钉待办 API,与既有裁决(A 方案)一致 |
| 权限码 | `approvals:read/write/act/admin/admin-templates/admin-data`、`approval-templates:manage`、`approvals:analytics`(`types/approval-product.ts:1-9`) | 【已有】是 `approvals:*` 不是 `approval:*` |

### 1.2 限制(本设计要解决或绕开的)

1. 【缺口·最高优先】遗留 `POST /api/approvals/:id/approve|reject`(`routes/approvals.ts:2593 / :2743`)只做 authenticate + `approvals:act` + version + status,然后裸 `UPDATE approval_instances SET status=...`(:2673-2679),**不查 assignment、不判 `published_definition_id`、不发完成事件**。任何持 `approvals:act` 的人可对模板运行时实例一键终结,且桥永久 pending、W7/FWB/投影都不触发。
2. 【缺口】多维表侧零入口:`MetaRecordInspector.vue:145-210` 头部动作与 :253-330 四个 tab、`MetaGridTable.vue:3-9` 批量条、按钮字段(`MetaFieldManager.vue:1157-1160` 仅 `record_click/send_notification`;`routes/multitable-button.ts:99-110` 无 `start_approval`)均无审批;`grep '/approvals' web/multitable` 为 0 行。
3. 【缺口】记录 ↔ 实例关联存在但不可查:桥表有 `sheet_id/record_id`(迁移 `zzzz20260610150000:63-80`)但只按 `execution_id/idempotency_key/approval_instance_id` 查,无索引无路由;投影表的 `record_id` 指投影行不指业务行。
4. 【缺口】幂等是执行级不是记录级:同一记录两次编辑 = 两个 `rootExecutionId` = 两张审批;整条 lineage 建过审批后 `retryExecution` 409 `START_APPROVAL_ALREADY_CREATED`(:2756-2762)。
5. 【缺口】桥 pending 无超时无清扫(全仓只有事件去重账本 :1743 与重试账本 :2744 有 sweep)。
6. 【缺口】发起人身份:`trigger_actor` 模式无 `actorId` 时静默回退到 `rule.createdBy`(bridge :471-473);actor 只带 userId/userName/email/roles/permissions,**不带 tenantId/department**(:505-511)→ attachments 落 `'default'` 租户(:8049)、metrics tenantId null(:8145)【行号待核实】;前端无 requester 模式 UI(`MetaAutomationRuleEditor.vue:4266-4268`)。
7. 【缺口】锁 × 写回互斥:若规则用 `lock_record` 自造审批期只读,完成时 `applyResultWritebackPatch` 以审批人做 `lockActorId` 调 `ensureRecordNotLocked` 抛错,整个写回被吞成 `backwriteSkipped`(:3500-3540 + `record-lock.ts:44-58`)。
8. 【缺口】深度守卫 fail-open:`approvalBridgeAutomationDepth` 的 catch 分支返回 null 被当成新链 depth 0(设计三给 :3196-3199,评审二抽查为 :3299-3316,**具体行号待核实**);且 `MAX_AUTOMATION_DEPTH=3` 意味着循环要先真实发出 2 张审批才停。
9. 【缺口】编辑器丢键:`MetaAutomationRuleEditor.vue:4244-4269` 对 `start_approval` 从零重建 config,`resultWriteback.onNonApproved` 与跨库三元组在 UI 不可编、保存即静默丢。
10. 【缺口】映射靠自由文本 key(缺口 9),模板改字段 key 后 undefined 渲染成空串(bridge :175),空表单审批照发;`getTemplateUsage`(:6375)是否统计自动化规则引用【待核实】。
11. 【缺口】无配额/断路器:全仓自动化只有跨库写配额(`automation-executor.ts:2849`),批量改字段 = 逐行送审 = 审批风暴。
12. 【限制】非 approved 无分支:bridge resume 非 approved 直接整条判失败、尾部不跑(:3045-3050);想分流只能另起 `approval.completed` 规则。
13. 【限制】`start_approval` 不能进 `condition_branch/parallel_branch`(:647-649,:674-676;executor :1827-1836)。
14. 【限制】`cancelled` 在 `ApprovalCompletionOutcome` 类型里存在(`ApprovalCompletionEvent.ts:7`),但由哪条路径实际发出【待核实】(`transition.action` 枚举无 `cancel`)。
15. 【限制】org pin `APPROVAL_S1_ORG_PIN_ENABLED` 默认 OFF 且不能贸然开(org_id 回填源缺失,`approval-instance-readability.ts` 头部 B-1/B-2)。
16. 【限制】历史面板 `MetaRecordHistoryPanel.vue:53` 裸渲染 `{{ item.source }}` = `approval`,无单号无链接。

### 1.3 今天在多维表里送审一行要走几步

**路径 A(自动化代理字段,需管理员预配)**
管理员一次性:① 打开高级规则编辑器 → ② 选触发器 `field.value_changed`(触发器清单里没有「手动/按钮」)→ ③ 选动作 `start_approval`,选模板(需 `approvals:read`,否则退化成手填模板 ID)→ ④ **手填**审批表单字段 key ↔ 记录字段的映射(自由文本,要背 key)→ ⑤ 可选配 3 个写回字段(状态/审批人/完成时间;`onNonApproved` 与跨库目标 UI 里配不了)→ ⑥ 编辑器自动切 `workflow_job_v1` → ⑦ 保存。
一线用户每次:⑧ 把某个代理字段改成约定值 → 规则触发 → **无确认、无回执、无进度、无「审批中」徽标**;若该用户没有 `approvals:write`,规则以 403 失败,记录已改但审批没发出去,用户不知道;审批终态后只有 3 个字段被写回一次。
**合计:管理员 7 步 + 一线 1 步,且一线看不到任何反馈。**

**路径 B(离开多维表去审批中心)**
① 离开多维表进 `/approvals` → ② 选模板进 `/approvals/new/:templateId`(`ApprovalNewView` 只认 `route.query.fromInstance`,不接 `recordId` 预填)→ ③ 在 `record-link` 字段用选择器**重新把这条记录找一遍再选中** → ④ 手填其余表单字段 → ⑤ 提交 → ⑥ 回多维表:记录上没有任何审批痕迹;审批详情也回不到来源行(`ApprovalDetailView` 零 multitable 引用)。
**合计:6 步,两次上下文切换,零回链。**

---

## 2 目标体验

按角色分六块,每块标明数据来源(全部是现有接口的读投影 + 一张新关联表),决策 UI 不复制。

### 2.1 记录级送审(一线用户)
- 入口:记录详情面板头部「送审」按钮 + 网格行右键「送审」;仅当本表有 enabled 的审批预设、当前用户对该记录有编辑权、且持送审权限码(见 §6-1)时可点,否则灰掉带 tooltip 说明原因。
- 弹窗:选预设(仅一个则跳过)→ **预览**:左列审批表单字段、右列将提交的值(按映射渲染;`record-link` 自动 = 本记录;必填但为空的项标红阻断)→ 可折叠「审批路线预演」(`route-preview`,展示将经过的节点与审批人)→ 提交。
- 冲突:同记录同模板已有在途实例 → 409 `RECORD_APPROVAL_IN_FLIGHT`,弹窗直接给「查看进行中的审批」。
- 提交成功后弹窗关闭,记录「审批」tab 自动切入并显示当前实例卡。

### 2.2 状态展示(所有能看记录的人)
- 网格:「审批」**虚拟列**徽标(审批中/已通过/已驳回/已撤回/已取消),由关联表派生,不落 `meta_records`;可选把状态/审批人/完成时间/意见映射写回用户自建字段(沿用 W7 `resultWriteback`)以支持筛选/分组。
- 记录详情面板第 5 个 tab「审批」:顶部当前实例卡(单号 requestNo、模板名、状态、第 N/M 步 + 当前节点、当前审批人、发起人、发起时间、SLA 剩余/超期红标)→ 中部时间线(`GET /api/approvals/:id/history`,16 个动作动词中文化)→ 底部历史审批折叠列表(该记录过往所有关联行)。
- 可见度:不满足 `canReadApprovalInstance` 五个 arm 的读者只见摘要行(状态/当前节点/审批人姓名),时间线与意见隐藏并提示「仅参与者可见」。
- 历史 tab 里 `source='approval'` 的修订改渲染为「审批 #{requestNo} 写回」并可点跳。

### 2.3 审批人工作面
- 决策**只在**审批中心 `/approvals/:id`(或钉钉卡片一键通过,驳回回 Web);表侧「审批」tab 对当前节点有活跃 assignment 的用户显示「待你审批」+「去处理」深链。
- 审批详情增加「来源记录」卡片:表名/记录主字段值/「在表中打开」(`?recordId=` 深链已存在)/「提交快照 vs 当前值」切换(当前值仅当审批人对该记录有多维表读权限时显示;不一致字段打黄标「送审后已变更」)。
- 原则:**审批人批的是提交时的 `formSnapshot`**,实时值只做参考;与模板 `policy.sourceOfTruth` 对齐。表侧嵌入决策抽屉(复用 `ApprovalCenterDetailPane`)两位评审均判为 v1 不做。

### 2.4 回写
- 完成事件四种(`approved/rejected/revoked/cancelled`)→ 关联行终态 → 按预设 `resultWriteback` 写状态/审批人/完成时间/意见(意见取最后一条 approve/reject 的 `approval_records.comment`)→ 修订 `source='approval:{requestNo}'` → realtime;预设路径默认 `onNonApproved=true`(驳回/撤回也写)。
- 若记录处于审批系统锁(见 §4-7)则写回以系统 actor 放行并同事务解锁。
- 写回字段被改型/删除 → 按 W7-1b 语义跳过并在关联行记 `writeback_state=skipped:<reason>`,记录 tab 显示黄条。
- 通知:预设级「完成时通知发起人」默认开(站内 + 钉钉工作通知),文案含单号/结果/意见/记录深链。
- 表单里审批人改过的值回写继续用 FWB(`write_approval_form_values`,approved-only,不动)。

### 2.5 批量与撤回
- 批量送审:网格多选 → 批量条「送审」→ 选预设 → **dryRun 逐行预检**(可送/已在审批中/必填缺失/无权)→ 确认 → 逐行独立事务发起 → 按 #5584 风格返回「成功 N,跳过 M(原因)」,失败行可点定位;同步上限 §6-7 定,超出转异步作业 + 轮询。
- 撤回:记录 tab 与行右键「撤回审批」,仅发起人可见,理由必填 → 透传 `POST /api/approvals/:id/actions {action:'revoke'}`;不可撤时以引擎 409(`APPROVAL_REVOKE_DISABLED/WINDOW_CLOSED`)兜底提示。批量撤回 v1 不做。
- 催办:透传 `POST /api/approvals/:id/remind`。
- 重新送审:状态为已驳回/已撤回且预设 `allow_resubmit` 时按钮变「重新送审」,弹窗顶部显示上次驳回意见与驳回人;新建实例,旧关联行 `is_current=false` 保留历史。

### 2.6 视图
- 第二期:靠 `resultWriteback` 映射到用户自建 select 字段后,现有视图筛选/分组/看板零查询层改造直接可用;管理员按需建「审批中」「待修改」视图,不自动创建。
- 第三期可选(§6-4):系统托管的「审批状态」select 字段(仅 `source='approval'` 可写、网格只读),以及「待我审批」「我发起的」viewer-relative 系统过滤器(需查询构建器扩展点【待核实】)。

---

## 3 平台形态

### 3.1 数据模型(全部新增在多维表侧;不给 `meta_records` 加审批列,不改 `approval_instances` 结构 —— 与投影服务既有原则一致)

**(1) `multitable_record_approvals` —— 记录 ↔ 实例的唯一读模型 / 真相源**

```
id, tenant_id, base_id, sheet_id, record_id,
approval_instance_id (UNIQUE, nullable 直到创建成功), approval_request_no,
template_id, template_version_id, published_definition_id, preset_id (nullable),
origin ('manual'|'button'|'batch'|'automation'), origin_ref (execution_id / batch_id / button field id),
idempotency_key (UNIQUE per tenant),
status ('creating'|'pending'|'approved'|'rejected'|'revoked'|'cancelled'|'failed'|'orphaned'),
outcome, current_node_key, requester_id, submitted_by,
last_event_version int default -1, writeback_state jsonb, protection, last_error, attempts,
is_current bool, created_at, completed_at, updated_at
```
索引:`(sheet_id, record_id, created_at desc)`;`(approval_instance_id)` unique;**部分唯一** `(tenant_id, sheet_id, record_id, template_id) WHERE status IN ('creating','pending')` = 同记录同模板同时只允许一张在途;`(status, updated_at)` 供 sweep。`failed` 行不占唯一索引,可重试生成新实例。

**(2) `multitable_sheet_approval_presets` —— 表级审批预设(字段映射的可维护单元)**

```
id, tenant_id, base_id, sheet_id, name, template_id, last_verified_template_version_id,
field_mappings: [{formFieldId, source: {kind:'field', fieldId} | {kind:'template', expr}}],
requester_choice_defaults, result_writeback {statusFieldId, approverFieldId, completedAtFieldId, commentFieldId, onNonApproved=true},
protection ('none'|'warn'|'lock', 默认 'warn'), launch_policy {who, ...},
allow_manual / allow_batch / allow_revoke / allow_resubmit, notify {...}, enabled
```
保存期校验:复用 `validateStartApprovalConfig` 的字段类型/select 闭集检查 + 模板可见性 + `record-link` 钉表必须等于本表;`GET /presets/:id/health` 报模板新版本待复核 / 映射目标 `formFieldId` 消失 / 类型漂移 / 回写字段漂移;**必填映射失效 → launch 422 `PRESET_MAPPING_DRIFT`,非必填漂移只告警**(两位评审对「仅告警」的否决与「硬阻断」的否决折中)。

**(3) `multitable_record_approval_batches`** —— 批次账本:`id, sheet_id, preset_id, actor, total/succeeded/failed, status, results jsonb`。

**(4) `approval_instances.metadata` 新增键**(`createApproval` 只透传不校验语义,约 5 行,:7889 附近已是 JSONB【行号待核实】):
`sourceRef {kind:'multitable_record', baseId, sheetId, recordId}`、`origin {kind, ruleId?, executionId?, requesterMode, triggeredBy}`。`business_key` 保持不动(§6-11)。

**(5) `meta_records` 锁列扩展**(第三期):`lock_kind ('manual'|'approval')`、`lock_ref (approval_instance_id)`;采用设计一的显式列而非设计二的 `locked_by='approval:'+id` 前缀(评审一否决前缀方案;评审二接受前缀作为最小代价 —— 本文取显式列,理由:人工锁/审批锁/解锁审计可区分,守卫判定不靠字符串)。

### 3.2 事件流与幂等

**发起(所有来源共用 `RecordApprovalService.launch`)**
```
launch(actor, recordRef, preset|template, formData, idempotencyKey, origin)
  → [tx1] 插关联行 status='creating'(幂等键 + 部分唯一索引在此裁决;冲突 409 并返回已有实例)
  → 渲染 formData(共享抽出的 renderFormData;record-link 自动填 {recordId})
  → createApproval(request + sourceRef, actor)        ← 自管事务,不可注入
  → [tx2] 回填 instance_id/request_no/version/status(若创建即终态则直接写终态)
  → 失败:置 failed + last_error(不占唯一索引)
```
自动化来源:`bridge.startApproval` 在插桥行的同处调用 `RecordApprovalService.recordLink(origin='automation', origin_ref=execution_id)`,幂等键沿用 `start_approval:{root}:{step}:{template}`;桥自己的 claim/resume/回写不变,关联行只做镜像 + 对账。历史桥行一次性回填。

**进行中**:`ApprovalTaskCreatedEventV1` → 更新 `current_node_key`(若载荷无 nodeKey【待核实】,则 tab 打开时按需 `GET /api/approvals/:id` 拉取)。

**终态**:四种 `ApprovalCompletionEventV1` → 第三个消费者(与 W6 桥 claim、投影并列,try/catch 隔离、失败进重试账本)→ `transition.toVersion > last_event_version` 才应用 → status/outcome/completed_at → 解审批锁 → 回写(`writeback_state` 幂等)→ realtime `record.approval_changed`(**不走 record.* 规则**,事件静默,与投影一致)。创建即终态时事件可能先于 tx2 到达 → 消费者对未知 instanceId 按 `metadata.sourceRef` 反查或延迟重试;tx2 落行时以 approval 当前 status 初始化,不依赖事件顺序。

**durable 开关**:开时事件来自 outbox,消费者必须同时注册到 outbox 消费侧 —— **注册点【待核实】**(`automation-service.ts:1092` 附近是 eventBus 版);本功能前置要求 `AUTOMATION_DURABLE_DELIVERY_ENABLED=true`(与 FWB 同一前置)。

**对账 sweep**(15 分钟,复用 `ApprovalSlaScheduler` 的 leader-lock 骨架):① `creating` 超 10 分钟 → 按 `sourceRef` 反查实例,否则置 failed;② `pending` 但实例已终态(遗留路由或事件丢失)→ 自动 reconcile 并计数告警;③ 记录已删除 → `orphaned` 并通知发起人;④ 顺带对 `origin='automation'` 行只告警不改桥状态。

### 3.3 API 形状(全部 authenticate;租户走 operator-scope,**不读 `x-tenant-id`**,不用 `user.tenantId` 做值面路由)

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/multitable/sheets/:sheetId/records/:recordId/approvals` | 记录编辑权 + 送审权限码 | 发起;201 `{link, approval}`;409 `RECORD_APPROVAL_IN_FLIGHT {existing}`;422 `PRESET_MAPPING_DRIFT` |
| POST | `.../records/:recordId/approvals/preview` | 同上 | 返回将提交的 formData + 必填缺失 + 路线预演 + 模板可见性预检(以当前用户身份) |
| GET | `.../records/:recordId/approvals` | 记录读权 | 关联行列表 + `canOpen`(`canReadApprovalInstance`)+ 可读者附完整 DTO + `drift[]` |
| GET | `/api/multitable/sheets/:sheetId/approvals?recordIds=&status=` | 记录读权 | 网格徽标批量取 |
| POST | `/api/multitable/sheets/:sheetId/approvals/batch-start` | 同发起 | `{presetId, recordIds[], dryRun?, idempotencyKey}`;GET `/batches/:id` 轮询 |
| CRUD | `/api/multitable/sheets/:sheetId/approval-presets(/:id/health)` | sheet 管理权 + `approvals:read` | 预设 |
| GET/POST | `/api/multitable/admin/record-approvals`;`.../:id/reconcile`;`.../:id/retry-launch` | `approvals:admin` 或平台管理员 | `retry-launch` 仅对 `failed`(未创建实例)行 |
| — | 撤回 / 催办 / 决策 | — | **不新增**,前端直接调 `/api/approvals/:id/actions`、`/remind`;禁止用遗留 `/approve`、`/reject` |
| GET | `/api/approvals/:id` | 现有 | DTO 增 `linkedRecords[]`(仅 `getApproval` 一处组装,列表不带;三处类型镜像同步) |
| GET | `/approvals/new/:templateId?sheetId&recordId&presetId` | 现有页面 | `ApprovalNewView` 增记录预填(在 `fromInstance` 之外) |

### 3.4 自动化里的审批节点

最小形态保持三件套:`start_approval`(新增 `presetId` 模式,继承预设的映射/写回/保护;旧手写映射保留)→ 隐式挂起(suspended job,已有)→ `condition_branch on {{steps[n].outcome}}`。
- 新增 `onOutcome: {rejected|revoked|cancelled: 'continue'|'fail'}`,默认 `fail` 保持现状;`continue` 时把 `{outcome, instanceId, requestNo}` 写进 step output 供分流(改 `automation-service.ts:3045-3050` 与 bridge :184-202 `stepResultForApproval`)。
- 补齐 `StartApprovalConfig` 类型里缺失的 `resultWriteback / onNonApproved / 跨库三元组`;编辑器 :4244-4269 改为保留未知键;补 requester 模式 UI。
- 不做:分支内审批、并行审批节点(受 `parallel_branch` 白名单与 join-all 限制)、`approval.completed` 载荷注入来源记录并放开记录类动作(两位评审均否决:会打开审批完成 → `record.updated` → 再送审的环,深度 3 只能「发两张假审批后停」)。按记录分流一律走 `onOutcome` + `condition_branch`,或 FWB 的 `recordLinkFieldId`。

### 3.5 快速表单与按钮字段的暴露

- 按钮字段:`BUTTON_ACTION_POLICIES` 新增 `start_approval {gate, sideEffecting:true}`(`routes/multitable-button.ts:99-110`),dispatch 直接调 `RecordApprovalService.launch(origin='button', 幂等键 button:{fieldId}:{recordId}:{clickNonce})`;前端 `BUTTON_ACTION_TYPES` 加项并绑定预设。发起人 = 点击者,同一道送审权限门。(第三期)
- 快速表单(`MetaAutomationManager.vue`):payload 无 `actions[]/executionMode/conditions` 是刻意的结构限制;设计二「服务端展开成 `workflow_job_v1` 规则」被评审二否决(高级编辑器往返易丢 `presetId`,且依赖先修丢键)。**本文立场:快速表单不暴露审批;一线用户走记录「送审」按钮与按钮字段;规则作者走高级编辑器。**若 owner 坚持快速表单暴露,前置条件是 :4244-4269 丢键修复 + 往返测试。

### 3.6 共享抽取清单

- 从 bridge 抽 `renderFormData`(:154-178)与 `loadAuthorizedActor`(:458-513)到 `multitable/approval-launch-shared.ts`,手动/按钮/批量/自动化共用。
- 从 `automation-service` 抽 `writeApprovalResultBack / applyResultWritebackPatch`(:3318-3363, :3466-3540)到 `multitable/approval-result-writeback.ts`,加「审批锁放行」参数。
- 审批表单字段选择器(从 `formSchema` 读出,替代自由文本框)做成组件,回灌给 `MetaAutomationRuleEditor`。
- 治理规则(记录级去重、配额、requester 策略)下沉到共享 `launch`,而不是把手动路径塞进作业引擎(设计三「一律构造成 `start_approval` 执行」被两位评审否决:会把不能进分支、整条不能重试、无 pending 清扫、suspended job/lineage 账本全部套到一次点击上)。

---

## 4 治理与护栏(必须先做清单)

| # | 项 | 状态 | 位置 / 说明 | 期 |
|---|---|---|---|---|
| 1 | 审批终态只能出自 `dispatchAction` 的 8 个发布点 | 【已有】座位闸 :9621;【缺口】遗留 `/approve`、`/reject` 裸 UPDATE | 对 `published_definition_id IS NOT NULL` 实例 409 `APPROVAL_RUNTIME_UNSUPPORTED`;开关 `APPROVAL_LEGACY_TERMINAL_ROUTES_ENABLED` 默认 false;扫描「实例已终态但桥仍 pending」补发/标 stale。前端 `web/approvals/api.ts` 无直调(本轮核实);移动端/外部调用方【待核实】 | **第一期前置** |
| 2 | 记录级去重 | 【已有】执行级幂等键 + 事件去重账本 + 租约;【缺口】同记录同模板在途仅一张 | 关联表部分唯一索引;`dedupPolicy` v1 只做 `reject`(默认)与 `attach`,不做 `supersede`(两位评审否决:自动撤回打扰审批人、要求发起人有撤回权) | 第二期 |
| 3 | 防环 | 【已有】`approval.completed` 白名单结构性防环(:219-232,:3178-3179 注释)+ `MAX_AUTOMATION_DEPTH=3`;【缺口】深度守卫 catch 分支 fail-open | catch 改为 fail-closed(视为 depth=MAX 跳过并告警);写回事件带 `origin={kind:'approval_writeback', instanceId, ruleId}`(值-free)供同 ruleId 默认自源回声抑制;保存期 lint:触发器 `record.updated` 且写回目标在同 sheet → 要求改 `field.value_changed` 并排除写回字段 | 第一期(lint 文档化)/ 第二期(代码) |
| 4 | 发起人身份可追责 | 【已有】`approvals:write` 门 + 命名空间准入 + org_id 从 requester 推导(:7959-7968);【缺口】`trigger_actor` 静默回退、actor 缺 tenantId/department、无 UI | `requester.mode` 显式化:`schedule/webhook + trigger_actor` 保存期禁配,无 actorId 直接失败并告警;**存量规则先迁移回填显式 mode(缺省 `rule_creator` + `needs_review`)再禁配**,不能上线即全红;actor 补 tenantId(从规则所在 base 推导)与 department(`ApprovalDirectoryOrg` 查,解析器按 actor.department 还是 userId 反查【待核实】);实例 `metadata.origin` 区分本人发起/规则代发 | 第二期 |
| 5 | 租户隔离 | 【已有】org_id 不读请求头、模板可见范围创建期复核、`approval.completed` 双腿权限;【缺口】桥 actor tenantId、attachments `'default'` | 桥 actor tenantId 与 requester 所属租户比对不等则 fail-closed;`approval.completed` 触发期加第三腿(事件 `publishedDefinitionId` 所属 org == 规则 sheet 的 org,模板 org 字段是否存在【待核实】);**不开** org pin | 第二期 |
| 6 | 广度防护 | 【缺口】无配额/断路器 | `start_approval` 规则级配额(每分钟/每天,超限 `skipped:quota_exceeded` + 通知作者);批量条/导入路径 dry-run 计数「将触发 N 张审批」确认;断路器与全写路径 `origin.batchId` 标记降到第三期(设计三自述漏一条即绕过;`import-xlsx` 是否发事件【待核实】) | 第二期(配额)/ 第三期 |
| 7 | 锁 × 写回 | 【缺口 5】 | 审批系统锁 `lock_kind='approval' + lock_ref`;`canEditWhileLocked` 加分支:审批锁下仅系统 actor(回写路径)可写;终态四种事件同事务幂等解锁(仅当 `lock_ref` 仍等于该实例);FWB「未锁」复检认得审批锁;预设级 `protection` 默认 `warn`(快照为真 + 漂移黄标),`lock` 可选。字段级锁不做(要过 patch/批量/导入/`update_record` 四条写路径且无单一收口【待核实】) | 第三期 |
| 8 | 空审批人 / 自动通过 | 【已有】三种 `EmptyAssigneePolicy` + 兜底资格 + `route-preview` | 预设/规则保存期以 requester 身份预演,空链或含 `requester_choice` 节点阻断;对 `origin≠manual` 实例的 `auto-approve` 改为**模板级 opt-in**(`allowAutoApproveFromAutomation`,默认关),不一刀切禁用(评审二) | 第二期 |
| 9 | 模板归档 / 版本漂移 | 【已有】发布定版、FWB `confirmationHash`;【缺口】自由文本 key、`getTemplateUsage` 不含规则引用【待核实】 | 预设/规则保存登记 `(templateId, refId)`;archive 前返回引用清单;health 端点;字段选择器替代自由文本 | 第二期 |
| 10 | 审计值-free | 【已有】桥 `trigger_event` 脱敏(:276)、`approval_records` 16 动作留痕、`automation-log-redact` | 新增载荷/日志/关联表只存 id/哈希/计数/状态;回链对「有权看记录无权看审批」的用户只给状态摘要;记录存在性按 `fillerCanReadRecord`「缺失与不可读同码」原则 | 贯穿 |
| 11 | durable 前置 | 【已有】开关 | 本功能要求 `AUTOMATION_DURABLE_DELIVERY_ENABLED=true`;222 与生产是否已开【待核实】(§6-9) | 第一期 |
| 12 | 钉钉只做 transport | 【已有】卡片 ledger-only、回调 approve-only | 不做钉钉待办、不做入站驳回;卡片状态镜像(完成/转交后置 outcome)为第三期可选 | 贯穿 |
| 13 | 类型与 UI 不丢键 | 【缺口】`StartApprovalConfig` 无 `resultWriteback`;编辑器 :4244-4269 从零重建 | 补类型 + 保留未知键 + 暴露 `onNonApproved` 与 requester 模式 | 第一期(极小开发) |

每期验收必含对抗性用例:同记录双击保存、批量 500 行、模板归档后触发、规则作者禁用后触发、遗留路由直调、桥表查询故障注入、完成事件重复投递、无权者只见摘要。

---

## 5 分期计划

### 第一期:零开发 / 极小开发 —— 只用 `start_approval` + `approval.completed` 配出闭环

**目标**:不写(或只写一个小 PR)代码,让一张表的一行记录能被送审、审批中心处理、结果写回记录并通知发起人。

**前置(运维/配置)**
- `AUTOMATION_DURABLE_DELIVERY_ENABLED=true`(否则完成事件走 post-commit emit,进程崩溃丢一次)。
- 一线送审用户所在角色持 `approvals:write`(`trigger_actor` 模式硬门,bridge :500-504);或规则用 `rule_creator` 模式(今天只能经 API 手写 config 注入)。
- 模板可见范围(`visibility_scope`)包含送审用户,否则 `createApproval` 在 :7935-7946 拒绝。
- 模板里 `record-link` 字段(如有)必须钉在本表;`requester_choice` 类审批人来源在程序化路径无人可选,模板不要用。
- **不要**调用遗留 `POST /api/approvals/:id/approve|reject`;所有决策走审批中心页面(它用 `/actions`)。

**表字段约定(表管理员建)**
- `审批状态` select,选项**必须**包含字面量 `approved` / `rejected`(W7 写回的是 outcome 字面量,类型校验要求 select 含该值 :527-553);再加一个人类可读的触发值,如 `待送审`。
- `审批人` string 或 person(W7 approverField 允许类型【待核实】,保守用 string)。
- `审批完成时间` dateTime。

**规则 1「送审」(高级编辑器)** —— 示例
```jsonc
{
  "name": "价格变更送审",
  "executionMode": "workflow_job_v1",          // 编辑器选 start_approval 后自动切
  "trigger": { "type": "field.value_changed", "fieldId": "<审批状态>" },
  "conditions": [ { "fieldId": "<审批状态>", "op": "eq", "value": "待送审" } ],
  "actions": [
    {
      "type": "start_approval",
      "config": {
        "templateId": "<模板 id>",
        "formDataMapping": {                    // 左侧是审批表单字段 key(要背)
          "product_name": "{{record.产品名称}}",
          "new_price":    "{{record.新价格}}",
          "reason":       "{{record.变更原因}}"
        },
        "requester": { "mode": "trigger_actor" },   // 无 UI,默认即此;需送审人持 approvals:write
        "resultWriteback": {
          "statusField":      "<审批状态>",
          "approverField":    "<审批人>",
          "completedAtField": "<审批完成时间>",
          "onNonApproved":    true              // ⚠ 编辑器不暴露且保存会丢;要么经 API 写规则,要么接受只在通过时写回
        }
      }
    }
  ]
}
```
防环说明:写回把 `审批状态` 改成 `approved/rejected` 会再次触发 `field.value_changed`,但 condition `= 待送审` 不命中,规则不再发起;深度守卫另作兜底。**不要**把触发器配成 `record.updated`。

**规则 2「完成通知」**
```jsonc
{
  "name": "价格变更审批结果通知",
  "trigger": { "type": "approval.completed", "config": { "templateId": "<模板 id>", "outcomes": ["approved","rejected"] } },
  "actions": [
    { "type": "send_notification", "config": { "to": "<发起人或固定人>", "message": "审批 {{approval.requestNo}} 结果:{{transition.toStatus}}" } }
    // 或 send_dingtalk_person_message;载荷可用 approval.*/transition.*/requester.id;能否动态指向 requester.id 【待核实】
  ]
}
```
规则创建者需持 `approvals:read` 且模板对其可见(:2403/:2406);该触发器不允许 conditions。

**一线用户操作**:把该行 `审批状态` 改成 `待送审` → 规则发起 → 审批人在审批中心「待办」处理 → 记录三个字段自动更新 → 发起人收到通知。

**验收标准**
1. 改值后 5 秒内(realtime)审批中心「我发起的」出现该单,`formSnapshot` 与记录值一致。
2. 审批中心通过 → 记录 `审批状态=approved`、`审批人`、`审批完成时间` 写回,历史 tab 出现 `source=approval` 的修订。
3. 审批中心驳回 → 若 `onNonApproved:true` 生效则写回 `rejected`,否则记录不变(记录此差异)。
4. 同一行连续两次改成 `待送审`(中间改回)→ 产生两张审批(**已知限制**,第二期修)。
5. 规则 2 通知到达。
6. 用遗留 `/approve` 路由终结该单 → 记录不写回、桥 pending(**验证缺口 1 存在**,作为第一期治理 PR 的反驳用例)。

**极小开发(一个 PR,≤ 2 人日)**
- (a) 遗留 `/approve`、`/reject` 对 `published_definition_id IS NOT NULL` 实例 409 + 开关默认关(护栏 #1)。
- (b) 编辑器暴露 `onNonApproved` 与 requester 模式,:4244-4269 保留未知键;`StartApprovalConfig` 补 `resultWriteback` 类型(护栏 #13)。
- (c) `MetaRecordHistoryPanel.vue:53` 把 `approval` 渲染成「审批写回」(单号需第二期关联表)。

**工作量**:配置 0.5 人日;极小开发 1–2 人日。

### 第二期:记录级送审入口 + 状态展示

**内容**
- 迁移:`multitable_record_approvals` + 索引;历史桥行回填脚本。
- `RecordApprovalService`:`launch`(两阶段)/ `recordLink`(桥镜像)/ `onCompletion` / `onTaskCreated` / `listForRecord`;共享抽取 `approval-launch-shared.ts`。
- `createApproval` 透传 `sourceRef`;`getApproval` 增 `linkedRecords[]`(三处类型同步)。
- 路由:发起 / preview / listForRecord / sheet 批量徽标。
- 预设最小版:`multitable_sheet_approval_presets`(模板 + 映射 + 写回 + `allow_*`),保存期校验;health 端点可留第三期,但**必填映射失效 → 422** 第二期就要有。
- 前端:面板「送审」按钮 + 行右键;送审弹窗(预览 + 路线预演 + 可见性预检);面板第 5 tab「审批」(当前实例卡 + 时间线 + 历史 + 摘要/明细分级);网格虚拟徽标列;撤回/催办/去处理透传;`ApprovalDetailView` 来源记录卡片;`ApprovalNewView` 记录预填;历史面板单号链接。
- 治理:护栏 #2(去重键)、#3(深度守卫 fail-closed + 写回 origin)、#4(requester 显式化 + 存量回填 + actor 补齐)、#5(租户第三腿)、#6(规则级配额 + 批量 dry-run 计数)、#8(预演阻断 + auto-approve opt-in)、#9(引用登记 + 字段选择器)。
- 权限码:按 §6-1 裁决实现 `approvals:submit-from-record` 或复用 `approvals:write`。

**验收标准**
1. 记录面板点「送审」→ 预览 → 提交 → 面板 tab 立即显示实例卡;审批中心可见同一单;审批详情「来源记录」可跳回该行并定位。
2. 同记录同模板在途时再送 → 409 并给「查看进行中的审批」;不同模板可并行。
3. 自动化 `start_approval` 发起的审批同样出现在记录 tab(`origin=automation`)。
4. 审批中心通过/驳回/撤回 → 关联行终态、写回字段、徽标在 5 秒内一致;重复投递同一完成事件不产生第二次写回(`last_event_version` 单调)。
5. 无权读实例的表读者只见状态摘要;`formSnapshot` 不出现在其响应里。
6. `creating` 行故障注入(createApproval 抛错)→ 行置 `failed`,可重试且不产生双实例。
7. 对抗:遗留路由直调 → 409;深度守卫桥表查询故障注入 → 跳过并告警而非 depth 0;`schedule` 触发 + `trigger_actor` → 保存被拒;存量规则迁移后无一条失效。

**工作量**:后端约 8–10 人日,前端约 6–8 人日,治理约 4 人日;**合计约 3 周(2 人并行 2 周)**。设计一「P0 两周」被两位评审判为低估,本文按 3 周。

### 第三期:一等关联的完整形态与批量

**内容**
- 批量送审(dryRun + 批次账本 + 逐行独立事务 + 异步作业)、重新送审(`is_current` + 上次驳回意见)、按钮字段 `start_approval`。
- `start_approval.onOutcome` + `presetId` 模式;`condition_branch on steps[n].outcome`。
- 审批系统锁(`lock_kind/lock_ref`,预设 `protection` 默认 `warn`)+ 写回/FWB 放行 + 终态解锁 + 漂移比对(来源 revision 哈希,值-free)+ 两侧黄标。
- sweep/reconcile/admin 路由 + 表设置「审批发起日志」页;指标出口(仓库 metrics 出口【待核实】)。
- 预设 health 端点、模板 archive 前引用提示、通知默认值(站内 + 钉钉工作通知)。
- 可选(§6-4 裁决后):托管「审批状态」select 字段;「待我审批」「我发起的」系统过滤器;钉钉卡片状态镜像;断路器 + 全写路径 `origin.batchId`。

**验收标准**
1. 多选 200 行批量送审 → dryRun 逐行原因正确 → 正式跑后「成功 N,跳过 M」与关联表一致;中途杀进程重放同 `idempotencyKey` 不重复发起。
2. `protection=lock` 下:审批中普通用户改映射字段 → 提示「审批中(单号)」;审批通过 → 写回成功且锁解除;`protection=warn` 下改值后审批详情与记录 tab 出现黄标。
3. 规则 `onOutcome.rejected='continue'` → 驳回后尾部 `condition_branch` 走驳回分支;默认 `fail` 行为不变(现有集成测试 `multitable-automation-start-approval.test.ts:995` 仍绿)。
4. 按钮点击 → 发起 → 同一点击重放不重复;点击者无送审权限 → 按钮 gate 拒绝。
5. 记录删除后 sweep 把关联行置 `orphaned` 并通知发起人;`pending` 但实例已终态的行被 reconcile。
6. 模板重新发布后 health 报「待复核」;删除必填映射目标字段后发起 → 422。

**工作量**:约 3–4 周(2 人)。

---

## 6 需要 owner 拍板的问题

1. **送审权限码**:一线用户从记录送审要不要持 `approvals:write`(它同时是审批中心对全部可见模板的发起权)?建议 **B:新增更窄的 `approvals:submit-from-record`**,只允许经预设从记录送审;不批量授予 `approvals:write`。第一期零开发阶段只能用 `approvals:write`。
2. **并发独占**:同记录同模板在途仅一张(部分唯一索引硬拦)、不同模板可并行、驳回/撤回后再送是新实例旧行留历史 —— 是否接受?业务上是否存在「同记录同类审批并行」?
3. **审批人批的是什么**:提交时快照(建议;默认 `protection=warn` + 漂移黄标)还是实时值(则第三期必须默认 `lock`)?
4. **状态字段形态**:第二期为「虚拟列 + 可选写回到用户自建字段」;第三期是否要系统托管的「审批状态」select(自动创建、只读、选项固定,需在导入/API/`update_record`/批量条全部拒写才不失真)?两位评审一赞成一反对,请裁决。
5. **可见度**:普通读者(非发起人/审批人/抄送/管理员)在记录侧只看状态与单号(建议)还是能打开详情?
6. **记录删除时在途实例**:仅标 `orphaned` 并通知发起人(建议;`revoke` 只有发起人能做),还是新增系统级 cancel 动作(要在 `dispatchAction` 之外开无座位的系统路径,安全面较大)?
7. **批量上限与待办风暴**:同步上限 50 还是 200?是否要求 admin 才能批量送审?是否需要「N 行合并成一张汇总单」(那是另一种模板形态,超出本设计)?
8. **遗留 `/approve`、`/reject` 路由**:是否同意在第一期就对模板运行时实例 409(开关默认关)?前端无直调已核实;移动端/外部调用方需 owner 确认。
9. **durable 开关**:222 与生产的 `AUTOMATION_DURABLE_DELIVERY_ENABLED` 是否已开?未开则要先评估打开对现有自动化的影响。
10. **定时/webhook 触发的审批以谁的名义发起**:坚持 `rule_creator`(规则作者成为海量审批发起人且持全部撤回权)还是引入 `record_owner`(`meta_records.created_by`,同样过权限门)?
11. **`business_key`**:保持 = 模板 key 不动,记录引用只放 `metadata.sourceRef`(建议);还是重定义为记录引用(需评估 `idx_approval_instances_workflow_business` 与 PLM 桥)?
12. **模板重新发布后的预设**:「必填映射失效才 422、其余告警可发起」(本文折中)是否可接受?
13. **自动化来源的 auto-approve**:模板级 opt-in 默认关(建议)还是保持现状允许?
14. **快速表单是否暴露审批**:本文立场不暴露(§3.5);若要暴露,接受先修丢键再做「服务端展开」的顺序?

### 待核实清单(不影响拍板,影响工时;上线前必查)
- `ApprovalTaskCreatedEventV1` 载荷是否含 `nodeKey` 字段名(`ApprovalTaskCreatedEvent.ts:43-63`)。
- durable 开关下 outbox 消费者的注册点。
- 深度守卫 fail-open 的精确行号(:3196-3199 vs :3299-3316)。
- `approvalBridge` actor 缺 tenantId 导致 attachments 落 `'default'`(:8049)与 metrics tenantId null(:8145)的行号与现象。
- `ApprovalAssigneeResolver` 按 `actor.department` 还是按 userId 反查目录。
- `getTemplateUsage`(:6375)是否统计自动化规则引用;`approval_templates` 是否有 org 字段。
- `cancelled` 完成事件的实际发出路径。
- `import-xlsx`(`routes/univer-meta.ts:14314`)与 `restore-batch-execute`(:10452)是否向自动化发记录事件。
- 记录写入是否有单一收口可下沉字段级锁守卫(第三期之后才需要)。
- 查询构建器是否有 viewer-relative 系统过滤器扩展点(仅 §6-4 选托管字段/动态视图时需要)。
- 是否有通用后台 job 框架可承载批量异步。
- `approval.completed` 通知动作能否动态指向 `requester.id`。
- W7 `approverField` 允许的字段类型集合。

---

## 附:三份设计的取舍记录(供追溯)

- **采纳骨架**:设计二(关联表 + 两阶段 launch + bridge 镜像 + `sourceRef`/`linkedRecords` + 预设 + sweep/reconcile + `onOutcome` + 共享抽取)。
- **采纳体验**:设计一(送审弹窗预览 + 路线预演、记录「审批」tab 信息架构、重新送审显示上次驳回意见、批量 dryRun 逐行结果、历史面板中文化、`lock_kind/lock_ref` 显式列、权限码方案 B)。
- **采纳治理**:设计三(遗留路由 409 前置、记录级去重、深度守卫 fail-closed + 自源回声抑制、requester 显式化 + actor 补齐 + origin 元数据、规则级配额、值-free 审计、钉钉只做 transport、预演阻断)。
- **否决**:设计三「所有送审构造成 `start_approval` 执行」与「一线入口压到 P3」;设计一「同事务落关联行」(createApproval 自管事务)、「`approval.completed` 注入来源记录放开记录类动作」、「字段级锁」、「托管字段 + 自动预置视图」作为默认、「表侧决策抽屉」;设计二「`locked_by` 前缀」、「预设仅告警可发起」、「快速表单服务端展开」、`supersede`;设计三「requester 立即必填无回填」、「一刀切禁 auto-approve」、「mapping 绑版本硬阻断」、「批量标记全写路径作 P0」。
