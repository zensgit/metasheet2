# PLM Workbench Approval History Display Parity Design

## Background

后端审批历史路由最近已经补齐了 richer contract：

- `actor_name`
- `actor_id`
- `from_version`
- `to_version`
- 兼容 `version`

但前端主产品页审批历史仍沿用旧展示语义：

- 用户列优先显示 `user_id`
- 没有消费 `actor_name`
- 没有展示版本迁移

这会导致：

- `Approval Inbox` 和产品页审批历史展示不一致
- 后端已经补齐的 richer history contract 没有真正被 UI 消费

## Design

抽一个共享 display helper，而不是在两个入口分别写 fallback：

1. `plmApprovalHistoryDisplay.ts`
   - `resolvePlmApprovalHistoryActorLabel(...)`
   - `resolvePlmApprovalHistoryVersionLabel(...)`

2. `PlmProductView.vue`
   - `getApprovalHistoryUser(...)` 改为优先读取 `actor_name`
   - 新增 `getApprovalHistoryVersion(...)`

3. `PlmApprovalsPanel.vue`
   - 审批历史表新增 `版本` 列
   - 用户列继续显示 actor label，但现在优先走 hydrated actor name

4. `ApprovalInboxView.vue`
   - history 表与产品页复用同一套 actor/version display helper
   - 两个入口的 approval history rich contract 展示对齐

## Expected Result

- 审批历史优先显示真实 actor name，不再稳定回退到 `user_id`
- 审批历史会显示 `from_version -> to_version`
- `Approval Inbox` 和产品页审批历史的展示语义保持一致
