# DingTalk Automation Link Card Actions Development 2026-04-21

## Scope

本次开发基于钉钉自动化规则的列表摘要能力，继续补齐规则卡片上的可点击入口：

- 在自动化规则卡片中展示钉钉公开表单入口。
- 在自动化规则卡片中展示内部处理视图入口。
- 公开表单入口复用现有公开表单 URL：`/multitable/public-form/:sheetId/:viewId?publicToken=...`。
- 内部处理入口复用现有 multitable 路由：`AppRouteNames.MULTITABLE`。
- 公开表单缺失 `publicToken`、未启用、过期或不是当前表单视图时，不渲染可点击公开表单入口。

## Implementation

### Rule Card Links

`apps/web/src/multitable/components/MetaAutomationManager.vue`

- 新增 `dingTalkCardLinks(rule)`，从 V1 `rule.actions` 和 legacy `rule.actionConfig` 中提取 `send_dingtalk_group_message` / `send_dingtalk_person_message` 的 `publicFormViewId` 与 `internalViewId`。
- 使用已有的 `listDingTalkPublicFormLinkBlockingErrors()` 校验公开表单视图，避免在配置不可用时给用户展示不可用链接。
- 使用已有的 `listDingTalkInternalViewLinkBlockingErrors()` 校验内部处理视图是否属于当前表格上下文。
- 公开表单链接读取视图配置里的 `config.publicForm.publicToken`，拼接绝对 URL，点击后新窗口打开。
- 内部视图入口使用 `router.push({ name: AppRouteNames.MULTITABLE, params: { sheetId, viewId } })`，保持 SPA 内部导航。
- 使用 `public-form:<viewId>` / `internal-view:<viewId>` 去重，避免一个规则多个钉钉动作重复渲染相同入口。

### UI

- 在规则描述下方新增 `meta-automation__card-links` 区块。
- 公开表单使用 `<a target="_blank" rel="noopener noreferrer">`。
- 内部处理使用按钮触发 router 导航。
- 新增 `data-automation-card-link` 测试选择器，方便后续 E2E 直接定位。

## Behavior

- 用户在自动化管理列表中可以直接打开配置好的“公开表单填写页”。
- 用户在自动化管理列表中可以直接跳转到配置好的“内部处理视图”。
- 如果公开表单未生成有效 token，规则描述仍保留文本摘要，但不会展示可点击公开入口，避免误导用户。

## Follow-up

- 本次只解决管理后台规则卡片的快速入口；钉钉群消息中的链接生成仍沿用后端 executor 的既有逻辑。
- 后续可在卡片入口旁补充权限状态提示，例如“仅绑定钉钉用户可填写”或“需授权后填写”。
