# 审批 MVP Wave 2 范围拆解

> 日期: 2026-04-11
> 基线: Wave 1 已在 `main` 收口
> 目标: 把“对标飞书审批”的下一阶段工作拆成可并行、可排期、可单独验收的工作包

---

## 1. 排期原则

Wave 2 不再重做 Wave 1 的基础模型，默认沿用:

- `approval_templates`
- `approval_template_versions`
- `approval_published_definitions`
- `approval_instances`
- `approval_records`
- `approval_assignments`
- `ApprovalGraphExecutor`

只有在以下前提成立时才允许动核心模型:

- 现有线性 / 条件分支图无法承载目标能力
- 兼容成本低于继续打补丁
- 有明确迁移方案和回滚方案

---

## 2. 建议的 5 个 Wave 2 工作包

### WP1. 审批流程能力扩展

目标:

- 并行分支
- 会签
- 或签
- return 到指定节点
- 审批人为空自动通过

涉及模块:

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/types/approval-product.ts`
- `packages/openapi/src/paths/approvals.yml`
- `apps/web/src/views/approval/*`

交付标准:

- 新节点 / 新聚合策略有契约和迁移说明
- 生命周期和并发测试补齐
- 历史时间线能表达多审批人结果

优先级: `P0`

---

### WP2. 统一 Inbox 与跨系统接入

目标:

- 把 PLM 审批接入统一 Inbox
- 评估考勤审批的统一视图策略
- 明确 `sourceSystem` 分层筛选

涉及模块:

- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/src/services/ApprovalBridgeService.ts`
- `packages/core-backend/src/services/AfterSalesApprovalBridgeService.ts`
- `apps/web/src/views/approval/ApprovalCenterView.vue`

交付标准:

- `platform / plm / attendance` 来源语义清晰
- 统一列表不会打坏现有模块入口
- 兼容回归测试覆盖 PLM / 考勤旧路径

优先级: `P0`

---

### WP3. 通知、催办与操作体验

目标:

- 催办
- 已读 / 未读
- 红点 / 待办计数
- 前端更细粒度错误态
- 操作后反馈和刷新体验

涉及模块:

- `apps/web/src/approvals/*`
- `apps/web/src/views/approval/*`
- 通知/消息基础设施

交付标准:

- 403 / 404 / 409 / 500 有明确 UI 分层
- 催办和未读状态有 API 和前端入口
- 操作反馈不再只有通用成功/失败 toast

优先级: `P1`

---

### WP4. 模板产品化能力

目标:

- 模板分类 / 分组
- 模板克隆
- 模板级 ACL
- 字段联动与条件显隐
- 更强的模板设计体验

涉及模块:

- `packages/core-backend/src/routes/approval-templates.ts` 或等价模板路由
- `apps/web/src/views/approval/TemplateCenterView.vue`
- `apps/web/src/views/approval/TemplateDetailView.vue`

交付标准:

- 模板中心可按分类管理
- 模板可见范围不是单一全局 manage 权限
- 字段条件配置可表达并可被后端验证

优先级: `P1`

---

### WP5. 统计、审计与运营能力

目标:

- 审批耗时统计
- 瓶颈分析
- SLA / 超时告警
- 报表导出

涉及模块:

- 后端聚合查询
- 报表接口
- 运维告警 / 指标链路

交付标准:

- 有明确统计口径
- 有分页和时间维度筛选
- 不影响 Wave 1 事务路径性能

优先级: `P2`

---

## 3. 不建议放入 Wave 2 的能力

这些能力会显著抬高复杂度，建议继续后移:

- 子流程
- 任意 DAG 流程
- 委托 / 代理审批
- 原生移动端
- PDF 导出 / 打印
- 钉钉 / 企微等多外部平台集成

---

## 4. 推荐的实施顺序

### 阶段 2.1

- WP1 审批流程能力扩展
- WP3 通知与操作体验中的错误态 / 操作反馈

理由:

- 直接提高产品可用性
- 不需要先扩大跨系统接入面

### 阶段 2.2

- WP2 统一 Inbox 与跨系统接入
- WP4 模板产品化能力

理由:

- 需要在流程模型稳定后再扩系统边界
- 模板 ACL 和分类更适合作为第二层产品能力

### 阶段 2.3

- WP5 统计、审计与运营能力

理由:

- 依赖足够的真实审批数据
- 适合放在核心闭环稳定之后

---

## 5. 建议的并行开发方式

### 主线 owner

负责:

- 流程模型
- 迁移
- 兼容边界
- 跨系统接入

### 并行块

- 前端体验与模板产品壳
- 统计报表和只读查询
- 文档、OpenAPI、验收脚本

原则:

- 任何影响 `ApprovalGraphExecutor` 或迁移的改动必须先冻结契约
- 不允许把 PLM / 考勤统一接入和流程模型扩展混成一条 PR

---

## 6. Wave 2 完成标志

满足以下条件可判定 Wave 2 完成:

- 支持至少一种多审批人策略（会签或或签）
- 统一 Inbox 至少纳入 `platform + plm`
- 模板中心具备分类或 ACL 其中一项
- 操作错误态和催办体验可用
- 有最小可用的审批统计视图

---

## 7. 与飞书差距的收敛策略

Wave 2 不是追求“功能全量对标”，而是优先收敛 3 个产品差距:

1. 流程表达能力不足
2. 统一入口不足
3. 运营能力不足

只要这 3 类收敛，整体产品感会明显接近飞书审批；其余高级能力可留到后续波次。
