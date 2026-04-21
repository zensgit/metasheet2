# DingTalk Public Form Access Helper Tests Development 2026-04-21

## Scope

本次开发继续补强钉钉公开表单访问等级的测试覆盖。上一层已新增 `getDingTalkPublicFormLinkAccessLevel()` 并在规则卡片、高级编辑器中使用 `data-access-level`；本次把该 helper 的行为补成独立纯函数单测，降低后续 UI 测试承担的范围。

## Implementation

`apps/web/tests/dingtalk-public-form-link-warnings.spec.ts`

- 在既有 public form link warning 测试文件中引入 `getDingTalkPublicFormLinkAccessLevel()`。
- 新增 `returns stable access levels for automation badges` 用例。
- 复用现有 fixtures，覆盖：
  - 未选择表单：`none`
  - 有效 public 表单：`public`
  - 有效 DingTalk-bound 表单：`dingtalk`
  - 有效 DingTalk-bound allowlist 表单：`dingtalk`
  - 有效 DingTalk-authorized 表单：`dingtalk_granted`
  - 有效 DingTalk-authorized allowlist 表单：`dingtalk_granted`
  - 视图不存在、非 form、未配置分享、分享禁用、缺 token、已过期：`unavailable`

## Rationale

组件测试已经覆盖 UI 上的 `data-access-level`，但 helper 的边界条件更适合用独立单测表达：

- 不需要挂载 Vue 组件。
- 对过期时间、缺 token、非法视图等分支更直接。
- 后续如果调整 UI 文案或样式，helper 行为仍有独立保护。

## Follow-up

- 如果未来新增访问模式，只需先扩展 helper 类型和本测试，再接入 UI。
- 如果未来把 public form access 文案中文化，当前等级测试不会受文案变更影响。
