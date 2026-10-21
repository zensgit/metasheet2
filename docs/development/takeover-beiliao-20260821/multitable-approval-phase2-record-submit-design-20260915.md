# 多维表 × 审批 阶段二设计：记录级「送审」（2026-09-15）

上游：`multitable-approval-integration-design-20260915.md`（#5724，总体设计）、`multitable-approval-demo-222-20260915.md`（#5745，阶段一实机闭环）。
本文是阶段二的实施级设计，依据 2026-09-15 owner 拍板的四项默认与一次只读代码地图（三路读者 + 批评者）写成；行号以 origin/main `28d11496b` 为准，实现时以 grep 为准。

## 0. 一句话

用户在多维表记录抽屉里点「送审」，选一个已发布的审批模板、填模板表单，系统创建审批实例并把它和这条记录绑定；同一记录 + 同一模板只允许一条在途实例；送审时记下记录版本，审批期间记录被改动只提示不阻断；审批完成后记录侧能看到结果。整条链不需要先建自动化规则。

## 1. 已拍板默认（不再讨论）

| 项 | 决定 |
| --- | --- |
| 权限码 | `multitable:submit-approval`，多维表命名空间，多维表侧播种与校验 |
| 在途唯一 | 同 (sheet, record, template) 仅一条 `creating/pending` 提交；再点提示「已在审批中」并给实例链接 |
| 快照与漂移 | 送审保存记录快照与版本号；审批中记录变更 → 记录侧与审批侧显示「数据已变更」，不阻断审批 |
| componentSpec | 中文名「组件规格」（模板已有 `labelZh`，222 仅需改名） |

## 2. 代码地图给出的硬约束（决定了方案形状）

1. **完成事件不一定走 eventBus。** `AUTOMATION_DURABLE_DELIVERY_ENABLED` 打开时 `emitApprovalCompletionEvent` 直接返回，完成事件只经耐久投递按**冻结的 v1 路由清单**分发给 `approval-bridge / approval-trigger / approval-projection`（`automation-routing-manifest.ts`）。新增消费者必须：清单 v2（`APPROVAL_COMPLETION_CONSUMERS_V2` 多一个 `multitable-record-approval`）、`SUPPORTED_MANIFEST_VERSIONS = {1,2}`、`DurableConsumerHandlers` 接口与 `DURABLE_CONSUMER_KEYS` 同步加键、`buildDurableConsumerHandlers` 注册处理器；启动时 `assertManifestCompleteness` 双向断言，缺任一侧即抛错。标志关闭的环境仍要订阅 eventBus（与桥接服务同样两条腿）。
2. **`createApproval` 自己再校验 `approvals:write`**（`ApprovalProductService` → `userHasApprovalsWriteOnQuery`，只认 `approvals:write | approvals:* | *:*` 或 DB 管理员，读 DB 不读 JWT）。所以 `multitable:submit-approval` 是多维表侧的入口门，**申请人角色还必须持有 `approvals:write`**。播种时两个码都给 `admin`；给普通角色由 owner 决定（见 §9）。
3. **审批实例没有"来源记录"列。** `approval_instances` 只有 `source_system/external_approval_id`（PLM 镜像用）和 `business_key`（调用方不可设）；`GET /api/approvals` 的作用域只给申请人/审批人/抄送/管理员。**记录侧的审批状态必须由多维表自己的表提供**，不能靠查审批中心。
4. **`createApproval` 自开连接自开事务**，不接外部客户端。链接行只能走桥接服务的三步：先插 `creating` → 调 `createApproval` → 成功改 `pending`（失败改 `failed` 并记错误）。不能"一个路由事务"。
5. **锁序。** `createApproval` 末尾会对 (sheet, record) 取 `pg_advisory_xact_lock('record-link:row-auth:…')`；我们的路由**不要**跨 `createApproval` 调用持有同键锁，"在途唯一"用部分唯一索引而不是锁。
6. **租户。** 路由不得用 `req.user.tenantId`/`x-tenant-id` 定作用域（已知洞）；记录归属靠 `resolveSheetCapabilities(req, …, sheetId)`；审批实例的组织由 `createApproval` 从申请人成员关系推导（`deriveApprovalInstanceOrgId`，0/多 → 422）。
7. **快照存储。** `meta_record_revisions.snapshot` 只在调用方传入时写且会被清理，不能依赖；提交表自存快照。`meta_records.version` 是漂移锚点。
8. **模板可见性。** `automation-approval-template-access.ts` 已有"按可见范围过滤 + 需 approvals:read"的多维表侧模板读取门，复用它而不是直接放开 `/api/approval-templates`。
9. **权限播种。** `multitable` 在 `NON_NAMESPACED_PERMISSION_RESOURCES` 里，不需要 namespace admission；播种参照 `zzzz20260830160000_add_multitable_manage_schema_permission.ts`（`permissions` 行必须先存在，`role_permissions` 有 FK）。`deriveCapabilities` 有两份（`access.ts` 与 `sheet-capabilities.ts`）必须同步加 `canSubmitApproval`；`MultitableCapabilities` 新增必填键会让 `PUBLIC_FORM_CAPABILITIES`、`DENIED_CAPABILITIES`、前端 `EMPTY_CAPABILITIES` 等穷举字面量编译失败——一并补。
10. **前端入口。** 记录抽屉真身是 `MetaRecordInspector.vue`，动作都在 kebab `MtMenu` 里；`MetaRecordDrawer.vue` 是冻结的兼容壳，新 prop/emit 必须在壳里同步转发，否则七个冻结 spec 静默失覆盖。抽屉可能无 router、无 apiClient 挂载：链接放 `hasRouter` 守卫后，客户端调用做空判断。新 spec 要登记到 `scripts/run-required-web-tests.sh`。

## 3. 数据模型

新表 `multitable_record_approval_submissions`（迁移 `zzzz2026091600xxxx_create_multitable_record_approval_submissions.ts`）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid pk | |
| sheet_id / record_id | text not null | 来源记录 |
| template_id | text not null | 审批模板 id |
| approval_instance_id | text null | 创建成功后回填 |
| approval_request_no | text null | 展示用编号 |
| status | text not null | `creating` / `pending` / `approved` / `rejected` / `revoked` / `cancelled` / `failed` |
| outcome | text null | 终态结果（与 status 同步，便于统计） |
| submitted_by | text not null | 申请人 user id |
| record_version_at_submit | int not null | 漂移锚点 |
| record_snapshot | jsonb not null | 送审时记录 data（原样，读时按字段权限过滤） |
| error | text null | `failed` 时的值无关错误码 |
| created_at / completed_at | timestamptz | |

索引：
- `UNIQUE (sheet_id, record_id, template_id) WHERE status IN ('creating','pending')` —— 在途唯一，INSERT 撞索引即 409 `RECORD_APPROVAL_IN_FLIGHT`（响应带已在途的 `approvalInstanceId/requestNo`）。
- `UNIQUE (approval_instance_id) WHERE approval_instance_id IS NOT NULL` —— 完成事件按实例定位。
- `(sheet_id, record_id, created_at DESC)` —— 抽屉列表。

不改 `approval_instances`，不改审批中心代码。

## 4. 后端

### 4.1 路由（`packages/core-backend/src/routes/multitable-record-approvals.ts`，挂在 `/api/multitable`）

- `POST /sheets/:sheetId/records/:recordId/approvals`  body `{ templateId, formData }`
  1. `resolveSheetCapabilities(req, query, sheetId)` → 需 `canRead` 且 `canSubmitApproval`（管理员短路）；记录必须存在于该表（`SELECT id, version, data, locked FROM meta_records WHERE id=$1 AND sheet_id=$2`），锁定记录允许送审（送审不写记录）。
  2. 模板可读性：`canReadApprovalTemplateForAutomation(actor, templateId)`；模板必须 `published`。
  3. 三步：INSERT `creating`（撞唯一索引 → 409）→ `approvalProductService.createApproval({ templateId, formData }, actor)`（actor 用桥接的 `loadAuthorizedActor` 同款加载器，但要补 `tenantId/department` 由 createApproval 自行推导的字段；403/422 原样透传为值无关错误码）→ UPDATE `pending` + 实例 id/编号；createApproval 抛错 → UPDATE `failed` + error，返回 4xx/5xx。
  4. 响应 `{ submission: { id, status, approvalInstanceId, requestNo, recordVersionAtSubmit, createdAt } }`。
  5. 审计：`multitable.record.approval.submitted`（值无关：sheetId/recordId/templateId/instanceId）。
- `GET /sheets/:sheetId/records/:recordId/approvals`  → 需 `canRead`；返回该记录的提交列表（按 created_at 倒序，默认 20 条），每条附 `drift: { changed: boolean, changedFieldIds: string[] }`：`changed = record.version > record_version_at_submit`，`changedFieldIds` = 快照与当前 data 逐键比较后，再按调用者字段权限过滤（复用记录读路径的字段掩码），永不返回值。
- 不提供撤回/删除（撤回走审批中心）。

### 4.2 权限

- 迁移 `zzzz2026091600xxxx_add_multitable_submit_approval_permission.ts`：INSERT `permissions('multitable:submit-approval')` ON CONFLICT DO NOTHING；`role_permissions('admin', …)`。是否授予 `user` 角色见 §9。
- `deriveCapabilities`（两份）加 `canSubmitApproval = isAdminRole || permissions.includes('multitable:submit-approval') || permissions.includes('multitable:*')`；`MULTITABLE_CAPABILITY_KEYS` 加键；穷举字面量处补 `false`。
- 前端 `MetaCapabilities.canSubmitApproval?: boolean`，`useMultitableCapabilities` 暴露 `canSubmitApproval`。

### 4.3 完成消费者（`multitable-record-approval`）

- 清单 v2：`ROUTING_MANIFEST_V2` 四个 `approval.*` 事件路由到 `[...APPROVAL_COMPLETION_CONSUMERS, 'multitable-record-approval']`，其余路由与 v1 相同；`CURRENT_ROUTING_MANIFEST = V2`；`SUPPORTED_MANIFEST_VERSIONS = {1, 2}`（在途 v1 行仍由旧路由分发）。
- 处理器：按 `approval_instance_id` 找提交行；不存在（不是记录级送审）→ 直接 ack；存在 → `UPDATE status=outcome, outcome, completed_at WHERE status='pending'`（幂等：已终态再收到重复投递不改）；发一条 `meta_record_subscription_notifications`（`notification.sent`，`record_id` 有值，message 值无关：「记录送审已{通过/驳回/撤销/取消}」）给申请人；并 `publishRecordRealtime('record-updated')` 让抽屉刷新。
- eventBus 分支：标志关闭时订阅 `approval.approved/rejected/revoked/cancelled` 走同一处理器（与桥接服务做法一致），两条腿共用幂等 UPDATE。
- 不在阶段二把结果写回记录字段（见 §8 阶段 2c）。

### 4.4 错误码（值无关）

`RECORD_APPROVAL_IN_FLIGHT`(409)、`RECORD_APPROVAL_TEMPLATE_NOT_PUBLISHED`(400)、`RECORD_APPROVAL_TEMPLATE_FORBIDDEN`(403)、`RECORD_APPROVAL_PERMISSION_DENIED`(403，缺 submit-approval 或 approvals:write)、`RECORD_APPROVAL_RECORD_NOT_FOUND`(404)、`RECORD_APPROVAL_CREATE_FAILED`(502，createApproval 抛非 4xx)。

## 5. 前端

- `MetaRecordInspector.vue` kebab 加 `<MtMenuItem data-testid="record-inspector-submit-approval">送审</MtMenuItem>`，`v-if="canSubmitApproval && apiClient && sheetId && record"`；`MetaRecordDrawer.vue` 壳同步转发新 prop `canSubmitApproval` 与新 emit。
- 新组件 `MetaRecordApprovalSubmitDialog.vue`（Teleport + `role=dialog`，沿用 `MetaExportDialog` 结构）：
  1. 模板下拉：`client.listApprovalTemplates({ status: 'published' })`（客户端方法加 `status` 参数，服务端已支持 `?status=`）；列表为空或 403 → 提示「无可用模板或无审批读取权限」，不显示手填 ID。
  2. 选中后 `GET /api/approval-templates/:id`（客户端新增 `getApprovalTemplate`）取当前版本表单字段，通用渲染 `text / longText / number / select / date / checkbox`；出现其他类型 → 禁用提交并提示「该模板含不支持的字段类型，请到审批中心发起」。
  3. 提交 → `client.submitRecordApproval(sheetId, recordId, { templateId, formData })`；409 → toast「该记录已在此模板审批中」+ 打开实例链接；成功 → toast「已送审 AP-xxxx」。
- 抽屉新面板 `MetaRecordApprovalPanel.vue`（自门控懒加载，照 `MetaRecordProvenancePanel` 纪律）：首次展开才 `client.listRecordApprovals(sheetId, recordId)`；每行：模板名、`StatusTag domain="approval"`、编号、申请人、时间、`drift.changed` 时显示「送审后数据已变更（N 个字段）」；`hasRouter` 时编号为 `RouterLink` 到 `/approvals/:id`。
- 标签：`meta-record-labels.ts` 新增 `record.submitApproval`、`approval.*` 键（zh/en 全齐）。
- 实时：收到 `record-updated` 后若面板已展开则重拉。

## 6. 验证矩阵

| 层 | 用例 | 位置 |
| --- | --- | --- |
| 后端单元 | 在途唯一（并发两次 INSERT 一成一 409）、状态机幂等（重复完成不改终态）、drift 计算与字段掩码、清单 v2 完整性断言、能力推导两份一致 | `tests/unit/multitable-record-approval-*.test.ts`（无 `request(app)`） |
| 后端 realdb | 路由端到端：无权限 403、未发布模板 400、成功 → 行 `pending` 且实例存在、409 重复、消费者收到 `approval.approved` → 行 `approved` + 通知行 | `tests/integration/multitable-record-approval-realdb.test.ts`（照 d1c realdb 套件的夹具） |
| 前端 | kebab 项按能力显隐（两处壳/真身）、对话框加载 published 模板、不支持字段类型禁用、409 提示、面板懒加载与漂移提示、无 router/无 client 挂载不崩 | `tests/multitable-record-approval-submit.spec.ts`、`tests/multitable-record-approval-panel.spec.ts`，登记到 `run-required-web-tests.sh` |
| 变异 | 去掉部分唯一索引 → 并发用例红；去掉幂等 WHERE → 重复完成用例红；清单 v2 不注册处理器 → 启动断言用例红 | 各 PR 自证 |
| 222 实测 | bom备料 任一记录 → 送审 → 审批中心通过 → 抽屉面板显示 approved + 铃铛通知；期间改一格 → 面板显示「数据已变更（1 个字段）」；同模板再送审 → 409 提示 | 上机记录 |

## 7. 实施拆分

- **PR 2a 后端**：迁移 ×2、路由、服务、消费者（清单 v2）、能力推导、单元 + realdb 测试。opus 实现 → 两路反驳（契约/失败关闭；耐久投递与幂等）→ 修复 → 终审。
- **PR 2b 前端**：kebab 项、对话框、面板、客户端方法、标签、spec。opus 实现 → 两路反驳（冻结壳与无 router 挂载；权限显隐与错误路径）→ 修复 → 终审。
- 2a 合并后先上 222（r47/r48），2b 合并后再上一版并做 §6 实测。

## 8. 后续（不在阶段二）

- **2c** sheet 级「审批设置」：状态字段映射 + `outcomeValues`，完成消费者顺带写回记录字段（复用 #5742 的解析）；
- 批量送审（多选记录）、抄送、撤回入口；
- 审批中心实例详情显示"来源记录"链接（需审批窗口在 DTO 暴露 `subjectSnapshot`/来源引用，另开 issue）。

## 9. 待 owner 一句话拍板（不阻塞 2a 开发，默认按括号内执行）

1. `approvals:write` 与 `multitable:submit-approval` 是否同时授予 `user` 角色？（默认：只给 `admin`，客户按岗位授予）
2. 快照是否需要对申请人以外的查看者做字段权限过滤？（默认：需要，按查看者字段权限掩码；值永不出现在 drift 响应里）
3. 记录锁定时是否允许送审？（默认：允许，送审不写记录）
