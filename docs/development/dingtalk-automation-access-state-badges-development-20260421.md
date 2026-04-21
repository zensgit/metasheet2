# DingTalk Automation Access State Badges Development 2026-04-21

## Scope

本次开发继续完善钉钉自动化公开表单权限可见性，在规则卡片和高级编辑器访问策略文案上增加语义等级。

目标：

- 让 UI 明确区分 `public`、`dingtalk`、`dingtalk_granted`、`unavailable`。
- 让 E2E/回归测试可以通过稳定 `data-access-level` 判断公开表单访问状态。
- 不把访问等级写入自动化规则 payload，保持它是由表单配置派生的 UI 状态。

## Implementation

### Shared Helper

`apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts`

- 新增 `DingTalkPublicFormLinkAccessLevel` 类型：
  - `none`
  - `unavailable`
  - `public`
  - `dingtalk`
  - `dingtalk_granted`
- 新增 `getDingTalkPublicFormLinkAccessLevel(viewId, views, options)`：
  - 未选择表单返回 `none`。
  - 视图不存在、非 form、未启用分享、缺少 public token、已过期，返回 `unavailable`。
  - 有效表单按 `accessMode` 返回 `public`、`dingtalk` 或 `dingtalk_granted`。
  - 非法 `accessMode` 继续按现有逻辑 fallback 为 `public`。

### Rule Card

`apps/web/src/multitable/components/MetaAutomationManager.vue`

- 规则卡片公开表单 access badge 增加：
  - `data-access-level`
  - `meta-automation__card-link-access--public`
  - `meta-automation__card-link-access--dingtalk`
  - `meta-automation__card-link-access--dingtalk_granted`
  - `meta-automation__card-link-access--unavailable`
- 卡片可点击入口仍只在公开表单配置可用时渲染；不可用配置继续不展示可点击公开入口。

### Advanced Rule Editor

`apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

- Group/Person 两个 public form selector 下方的 access summary 增加：
  - `data-access-level`
  - `meta-rule-editor__access-summary--public`
  - `meta-rule-editor__access-summary--dingtalk`
  - `meta-rule-editor__access-summary--dingtalk_granted`
  - `meta-rule-editor__access-summary--unavailable`
- 不可用公开表单在编辑器中会显示 `unavailable`，并继续保留阻断保存的 warning。

## Tests

`apps/web/tests/multitable-automation-manager.spec.ts`

- 规则卡片 fully public badge 输出 `data-access-level="public"`。
- 规则卡片 DingTalk-bound allowlist badge 输出 `data-access-level="dingtalk"`。
- 规则卡片 DingTalk-authorized allowlist badge 输出 `data-access-level="dingtalk_granted"`。

`apps/web/tests/multitable-automation-rule-editor.spec.ts`

- Group selector disabled public form 输出 `data-access-level="unavailable"`。
- Group selector fully public 输出 `data-access-level="public"`。
- Group selector DingTalk-bound allowlist 输出 `data-access-level="dingtalk"`。
- Person selector DingTalk-authorized allowlist 输出 `data-access-level="dingtalk_granted"`。
- Person selector disabled public form 输出 `data-access-level="unavailable"`。

## Follow-up

- 后续 E2E 可以直接断言 `data-access-level`，不需要解析英文文案。
- 如果产品希望中文化，可只替换 summary 文案，等级字段和样式无需调整。
