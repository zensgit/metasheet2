# DingTalk Automation Editor Access Summary Development 2026-04-21

## Scope

本次开发继续完善钉钉自动化标准功能，把公开表单访问策略从规则卡片进一步前移到高级自动化规则编辑器的钉钉动作配置区。

目标：

- 用户选择公开表单视图后，立即看到该表单的填写权限策略。
- Group 和 Person 两类钉钉动作都保持一致体验。
- 复用既有公开表单访问摘要 helper，不新增第二套权限文案。

## Implementation

### Advanced Rule Editor

`apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

- 在 `send_dingtalk_group_message` 的 `Public form view` 下拉框下方新增 access summary。
- 在 `send_dingtalk_person_message` 的 `Public form view` 下拉框下方新增 access summary。
- 仅当 `publicFormViewId` 有值时显示该提示，未选择公开表单时不额外占位。
- 访问策略继续调用 `publicFormAccessSummary(action.config.publicFormViewId)`，该函数内部复用 `describeDingTalkPublicFormLinkAccess()`。
- 新增稳定测试选择器：
  - `groupPublicFormAccessSummary-<idx>`
  - `personPublicFormAccessSummary-<idx>`

## Behavior

选择公开表单后，用户可以直接在选择框附近看到：

- `Fully public; anyone with the link can submit`
- `DingTalk-bound users in allowlist can submit`
- `Authorized DingTalk users in allowlist can submit`

这不改变保存 payload，也不改变钉钉消息链接生成逻辑，只补充编辑时的权限可见性。

## Tests

`apps/web/tests/multitable-automation-rule-editor.spec.ts`

- group 钉钉动作选择 fully public 表单后，选择框下方显示 fully public access summary。
- group 钉钉动作选择 DingTalk-bound allowlist 表单后，选择框下方显示 bound allowlist access summary。
- person 钉钉动作选择 DingTalk-authorized allowlist 表单后，选择框下方显示 authorized allowlist access summary。
- 原有 Message summary 访问策略仍保留，防止 UI 前移破坏既有预览。

## Follow-up

- 当前提示为文本级别。后续可在公开/受控/授权三类策略上增加不同视觉等级，减少 fully public 表单被误用到钉钉群的风险。
