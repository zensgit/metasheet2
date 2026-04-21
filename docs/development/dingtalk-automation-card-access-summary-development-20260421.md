# DingTalk Automation Card Access Summary Development 2026-04-21

## Scope

本次开发继续完善钉钉自动化规则卡片体验，在上一层“卡片可点击打开公开表单/内部视图”的基础上，增加公开表单访问策略提示。

目标是让表格持有者在自动化规则列表里直接判断：

- 该钉钉消息里的公开表单是否完全公开。
- 是否仅允许已绑定钉钉的系统用户填写。
- 是否仅允许管理员授权过的钉钉用户填写。
- 是否叠加了系统用户或成员组 allowlist。

## Implementation

### Rule Card UI

`apps/web/src/multitable/components/MetaAutomationManager.vue`

- 将规则卡片里的钉钉入口改为每个入口一个 `meta-automation__card-link-item`。
- 公开表单入口继续使用上一层实现的 `<a target="_blank">` 打开公开表单。
- 内部处理入口继续使用按钮触发 `router.push()`。
- 仅公开表单入口渲染访问策略说明：
  - 使用 `describeDingTalkPublicFormLinkAccess(publicFormViewId, formViews.value)`。
  - 通过 `data-automation-card-link-access="public-form:<viewId>"` 暴露稳定测试选择器。
- 新增 `accessSummary?: string` 到 `DingTalkCardLink`，不影响内部视图入口。

### Access Text

访问策略文案复用既有 helper，不新增第二套文案：

- `Fully public; anyone with the link can submit`
- `All bound DingTalk users can submit`
- `DingTalk-bound users in allowlist can submit`
- `All authorized DingTalk users can submit`
- `Authorized DingTalk users in allowlist can submit`

## Tests

`apps/web/tests/multitable-automation-manager.spec.ts`

- 默认公开表单入口展示 fully public 策略。
- 钉钉群规则卡片入口展示 `DingTalk-bound users in allowlist can submit`。
- 钉钉个人规则卡片入口展示 `Authorized DingTalk users in allowlist can submit`。
- 缺少 public token 的公开表单仍不渲染可点击公开入口。

## Follow-up

- 当前策略提示只展示在自动化规则列表卡片；规则编辑器预览区已有公开表单访问摘要。
- 后续如果需要更强提醒，可按 access mode 给 badge 增加 warning/protected 视觉状态。
