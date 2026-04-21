# 审批 Wave 2 当前状态复核与收口建议

> 日期: `2026-04-21`
> 当前基线: `origin/main` @ `923b43ebd`
> 工作分支: `codex/approval-wave2-20260413`
> 方法: `#837` 旧文档复核 + 当前代码审阅 + targeted tests + 只读 explorer 后端复核

---

## 1. 结论

`#837` 的原始结论已经部分过时。当前审批系统不是停留在 2026-04-13 的“准备启动 Wave 2 包 1A”状态，而是已经合入了一部分 Wave 2 节点级能力：

- `approvalMode: 'single' | 'all' | 'any'` 类型已存在。
- `emptyAssigneePolicy: 'error' | 'auto-approve'` 类型与运行时已存在。
- `return` action 与 `targetNodeKey` 已存在。
- 模板详情和审批详情 UI 已能展示一部分新能力。

但当前实现仍然不是 true parallel / join DAG：

- 图执行仍是单路径推进。
- `condition` 只选择一条分支继续。
- `approval` 完成后只沿一个 next edge 继续。
- `cc` 只产生事件，不创建活跃分支。
- `all` 是“同一审批节点内多审批人聚合”，不是并行分支合流。

因此，下一步不应再按“从零开始做 Wave 2 包 1A”推进，而应改成：

1. 收口并补强当前已落地的节点级能力。
2. 明确 `any` 语义当前与 `single` 等价，决定是否需要真正做“任一多人审批”。
3. 将 true parallel / join 继续保留为单独设计包，不混入当前节点级收口。

---

## 2. 当前已验证能力

### 2.1 类型与契约

后端和前端类型均已包含：

- `ApprovalMode = 'single' | 'all' | 'any'`
- `EmptyAssigneePolicy = 'error' | 'auto-approve'`
- `ApprovalActionType` 包含 `return`
- `ApprovalActionRequest.targetNodeKey`

涉及文件：

- `packages/core-backend/src/types/approval-product.ts`
- `apps/web/src/types/approval.ts`

### 2.2 后端运行时

当前后端支持的真实语义：

- `single`: 当前审批人通过后，当前节点完成并推进到下一节点。
- `all`: 同一审批节点下所有活跃 assignee 都处理后才推进；未全部完成时实例保持 pending。
- `any`: 当前代码没有独立分支，实际走与 `single` 相同的推进路径。
- `emptyAssigneePolicy=auto-approve`: 空审批人节点会自动通过并继续向后解析。
- `emptyAssigneePolicy=error`: 默认失败路径，空审批人节点会报错。
- `return`: 仅 template-runtime approvals 支持，且 `targetNodeKey` 必须是当前路径上先前访问过的 approval 节点。

涉及文件：

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/routes/approvals.ts`

### 2.3 前端展示与动作

当前前端已覆盖的消费面：

- 模板详情页展示 `approvalMode` 标签。
- 模板详情页展示 `emptyAssigneePolicy` 标签。
- 审批详情页展示 `approvalMode` / `aggregateComplete` 等 timeline metadata。
- 审批详情页展示 `return` 事件 metadata。
- 审批详情页在存在可退回节点时提供 `return` 操作入口，并提交 `targetNodeKey`。

涉及文件：

- `apps/web/src/views/approval/TemplateDetailView.vue`
- `apps/web/src/views/approval/ApprovalDetailView.vue`

---

## 3. 仍未支持或仍需收口的点

### 3.1 不支持 true parallel / join

当前执行器仍是单活跃节点模型。`current_node_key/current_step/total_steps` 也仍然偏向单路径表达，不适合表示多个同时活跃分支。

不要把当前 `all` 称为“并行审批”。它只是单节点多审批人聚合。

### 3.2 `any` 语义需明确

当前 `any` 在类型和配置校验层存在，但运行时没有独立逻辑；实际效果与 `single` 一致。

如果产品定义中 `any` 只是“多人中任一人处理即可”，当前行为基本可接受，但需要补文档和显式测试。如果产品定义要求更复杂的候选组/多 assignment 剩余清理语义，则需要单独补实现和回归。

### 3.3 `return` 范围需明确

当前 `return` 不是通用 legacy approval action。它依赖 template runtime graph，只能退回当前路径上已访问过的 approval 节点。

这条限制应该写进 API 文档和前端提示，避免用户以为可以任意退回任意节点。

### 3.4 UI authoring 仍需确认

当前前端已能展示 `approvalMode`、`emptyAssigneePolicy`，也能在审批详情页执行 `return`。但模板设计/编辑侧是否完整支持创建这些配置，需要另行做 UI round-trip 验证。

---

## 4. Wave 1 blocker 复核

原 Wave 1 报告里的真实环境项仍然不能通过本地单测完全替代：

| ID | 类别 | 当前状态 |
| --- | --- | --- |
| BL1 | 模板权限 | 本地 RBAC route tests 已覆盖 401/403/200 关键路径；真实账号仍需 staging 验证 |
| BL2 | 发起权限 | 本地 RBAC route tests 已覆盖只读不可写；真实账号仍需 staging 验证 |
| BL3 | 权限矩阵 | 本地 permission matrix integration 已覆盖；真实账号仍需 staging 验证 |
| BL4 | 只读行为 | 本地后端边界已覆盖；真实 UI 点击仍需 staging 验证 |
| BL5 | PLM 旧链路兼容 | 本次未复跑真实 PLM 联动 |
| BL6 | 考勤旧链路兼容 | 本次未复跑真实考勤联动 |

与 2026-04-13 文档不同的是：本地依赖环境已可运行审批 targeted tests，不再是“pnpm / uuid / pg / express / kysely 缺失”的工作站阻塞。

---

## 5. 推荐下一步

### 5.1 立即做: Wave 2 节点能力收口

建议开一个新的实现包，目标不是大改 DAG，而是把当前已存在的节点能力补齐到可发布状态：

- 给 `any` 补显式运行时测试，确认它与 `single` 的产品语义是否一致。
- 给 `all` 补“最后一个审批人处理后推进”的显式测试。
- 给 `return` 补更多非法目标测试，包括非 approval 节点、未访问节点、当前节点自身。
- 给 `emptyAssigneePolicy=error` 补显式失败测试。
- 补 API 文档，明确 `return` 和 `all/any/single` 的边界。
- 补模板配置 UI round-trip 验证，确认能创建并保存新配置。

### 5.2 暂缓做: true parallel / join

true parallel / join 需要单独设计，不建议混入当前包：

- 多活跃节点状态模型。
- join 完成条件。
- assignment 与 history 的 branch metadata。
- return/revoke 在多分支上的语义。

在这些契约没冻结前，不应直接改 `ApprovalGraphExecutor` 成 DAG 聚合状态机。

---

## 6. 本轮验证摘要

本轮在 rebase 到 `origin/main` @ `923b43ebd` 后执行了 targeted tests：

- 后端审批 targeted tests: `36/36 passed`
- 前端审批 targeted tests: `85/85 passed`
- `git diff --check`: passed

完整命令和输出摘要见：

- `docs/development/approval-wave2-current-state-verification-20260421.md`

---

## 7. 合并建议

`#837` 现在应作为“当前审批 Wave 2 状态复核与下一步收口建议”文档合入，而不是作为旧版“准备启动 1A”的计划合入。

合入后，建议新开实际实现 PR：

- `Wave 2 node capability hardening`
- 范围只包含 `single/all/any/return/emptyAssigneePolicy` 的测试、文档和小修
- 不包含 true parallel / join
