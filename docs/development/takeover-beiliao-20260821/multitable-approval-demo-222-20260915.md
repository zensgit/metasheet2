# 多维表 × 审批 阶段一演示：222 实机落地与闭环验证（2026-09-15）

配套设计：`docs/development/takeover-beiliao-20260821/multitable-approval-integration-design-20260915.md`（#5724）。
本文记录设计中"阶段一（零代码：用现有 `start_approval` / `approval.completed` 打通）"在 222 上的实际配置、验证证据与发现的缺口。全部操作在 222 的 Web UI 完成（admin@local.com 会话），SQL 仅用于探针与两处只涉及本演示新建对象的修正。

## 1. 结论

- 阶段一在 222（main `f274316f6`，r44）**无需改代码即可跑通**：记录字段变化 → 自动发起审批 → 审批中心处理 → 结果写回记录 → 完成事件触发通知。
- 端到端时延：记录保存到审批实例创建 ~0.2 s；审批通过到记录写回 ~0.03 s；两条规则执行均 `success`。
- 跑通前踩到三处缺口，已分别立 issue：#5741（审批窗口）、#5742（多维表侧）、#5743（多维表前端）。

## 2. 222 上新建的对象（全部可删，不涉及客户数据列）

| 对象 | 标识 | 说明 |
| --- | --- | --- |
| 审批模板「备料送审示例」 | key `multitable_stock_prep_demo`，id `2c4e479e-0ccd-4448-aff0-26fbb07b8ab2`，v1 已发布 | 分类「多维表」，表单字段 说明(文本)、备注(多行)，流程 发起 → 审批人1(指定成员 admin@local，单人通过) → 结束 |
| bom备料 新字段「审批状态」 | `fld_dd29d1ec-d8a0-43be-9390-c7793d513777`，单选 | 选项：`待审批` / `approved` / `rejected`（英文原因见 §5.2） |
| 规则 A | `atr_43ef50ae-dd7f-4f1d-b4e6-8389d2df0018` | `field.value_changed`（审批状态 变更为 待审批）→ `start_approval` |
| 规则 B | `atr_56c1bc00-867a-473c-9d6f-670d5dfb30f9` | `approval.completed`（同模板，outcomes approved+rejected）→ `send_notification` 给 admin |
| RBAC | `permissions('approvals:read')` + `role_permissions('admin','approvals:read')` | 保存规则 B 的前置，见 §5.1 |

规则 A 的 `start_approval` 配置：

```json
{
  "templateId": "2c4e479e-0ccd-4448-aff0-26fbb07b8ab2",
  "formDataMapping": { "说明": "fld_d917cb0fd097d45eccd8bce0", "备注": "fld_433ee27ceb33eb4d23304b55" },
  "resultWriteback": { "statusField": "fld_dd29d1ec-d8a0-43be-9390-c7793d513777" }
}
```

（`fld_d917…` = 当前组件（零件）名称；`fld_433e…` = 备注。）

为什么不复用「备料状态」加选项：该字段的 `property.stockPreparation.optionSync` 由客户包 `factory-a-rehearsal` 拥有（`preserveOnRefresh: true`），选项来自 `config_info.stock_preparation_status`；往里塞审批态会在下一次拉取/刷新时与源侧字典打架。审批态用独立列，正是设计文档 §4 "审批状态字段与业务状态解耦"的做法。

## 3. 操作步骤（可在任何实例复现）

1. 审批中心 → 模板 → 新建：基础信息（Key/名称/分类「多维表」）→ 表单设计（说明、备注）→ 流程设计（审批人 1：指定成员 → 搜 admin → 选中）→ 更多设置默认 → 测试发布 → 检查并发布（三项 ✓）→ 确认发布。
2. 多维表 → 备料 base → bom备料 → 字段 → 底部「字段名称」填 审批状态、类型 单选 → 选项 待审批 / approved / rejected → + 添加。
3. 自动化 → + 新建自动化（完整编辑器）：
   - 规则 A：触发器「当字段值变化时」，监听字段 审批状态，条件「变更为」，值 待审批；动作「发起审批」，审批模板 ID 粘贴模板 id；表单字段映射 +字段 两行（说明 ← 当前组件（零件）名称，备注 ← 备注）；审批结果写回 → 状态字段 = 审批状态；保存。
   - 规则 B：触发器「当审批完成时」，审批模板 ID 同上，勾选 通过 + 拒绝；动作「发送通知」，收件人搜 admin 选中，消息填一句话；保存。
4. 演示：打开任一记录 → 审批状态 选 待审批 → 审批中心「待我处理」出现 `备料送审示例` → 通过 → 回到记录，审批状态变 `approved`；🔔 通知 +1；管理 → 自动化运行 出现两条 success。

## 4. 验证证据（222 数据库探针，仅结构与时间，无业务值）

| 时刻 | 事件 |
| --- | --- |
| 16:29:40.269 | `meta_records` rec_c5918f1c… 审批状态 = 待审批（UI 记录抽屉保存） |
| 16:29:40.363 | 规则 A 执行 `success` |
| 16:29:40.441 | `approval_instances` 9732a879… `pending`（审批中心编号 AP-100001，第 1/1 步） |
| 16:30:12.816 | 实例 `approved`（审批中心「通过」→ 确认） |
| 16:30:12.846 | 记录写回：审批状态 = `approved` |
| 16:30:12.868 | 规则 B 执行 `success`，步骤输出 `{"persisted":1,"notifiedUsers":1}`；`meta_record_subscription_notifications` +1 |

截图（本会话 scratchpad，未入库）：模板发布页、规则 A 编辑器、规则列表、待办 AP-100001、通过后空列表、自动化运行记录。

## 5. 发现的缺口

### 5.1 `approvals:read` 从未播种，管理员保存不了完成触发规则（#5741，审批窗口）

保存规则 B 时服务端拒绝：`approval.completed rules require the creator to hold approvals:read for the configured template`。222 的 `permissions` 表只有 `approvals:admin / admin-data / admin-templates / analytics`；main 的迁移 `zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts` 也只播种这三个 admin 码，`access-presets.ts` 引用的 `approvals:read` 没有任何迁移写入（FK 约束下也无法直接授予）。`hasPermissionCode` 又不把 `approvals:admin` 视作 `approvals:read` 的超集。222 已手工补码并授予 admin；建议迁移播种或超集判定，两处校验（保存/触发）一致。

### 5.2 写回值是英文 outcome 原文，单选必须含 `approved`/`rejected`（#5742，多维表侧）

第一次保存规则 A 被拒：`resultWriteback.statusField select fld_dd29… does not include option approved`。`automation-service.ts` 校验目标单选的选项必须含 outcome 原文，执行器写回的也是原文。中文客户表只能建混合选项。建议在 `resultWriteback` 增加 `outcomeLabels` 映射（校验改为映射后值在选项中），编辑器同步一个「结果 → 选项」小表。

### 5.3 多维表页 fields/context 每秒成对重拉（#5743，前端）

打开 bom备料 后 DevTools 持续看到 `GET /api/multitable/fields` + `GET /api/multitable/context` 成对 304，约每秒一对，十几分钟 900+ 条。疑似 watcher 依赖返回对象引用触发 refetch 循环，或 context 的 baseId 归一化来回切换。与本演示无关，但会放大后端负载并刷日志。

### 5.4 通知铃铛计数与列表不一致（未立 issue，待复现）

规则 B 触发后铃铛显示「🔔 通知 1」，点开面板为「暂无通知」。可能是面板只列记录订阅类通知而计数含自动化通知；需要再复现一次再定。

## 6. 下一步（按设计文档分期）

- 阶段一收尾：编辑器保留 `start_approval` 原配置的修复 #5739（CI 绿后合并、随 r45 上 222）。
- 阶段二（记录级「送审」入口 + 审批状态字段规范化）设计稿待 owner 拍板四项默认：权限码 `approvals:submit-from-record`；同记录+同模板仅一条在途实例；送审快照 + 漂移提示；componentSpec 中文名。
- 演示对象清理：若不保留，删除规则 A/B、字段「审批状态」、模板（停用即可）、以及 `approvals:read` 授予（建议保留到 #5741 落地）。
