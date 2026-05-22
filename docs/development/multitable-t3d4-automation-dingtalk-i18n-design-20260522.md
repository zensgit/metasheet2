# T3D-4 Automation DingTalk i18n Design

Date: 2026-05-22

Branch: `frontend/multitable-t3d4-automation-dingtalk-i18n-20260522`

Base: `origin/main@b42cd00b6` (`feat(multitable): localize automation manager chrome (T3D-3) (#1744)`)

## 1. Decision Summary

T3D-4 is the final PR in the 4-PR T3D automation i18n chain.

| Decision | Outcome |
| --- | --- |
| Module | Continue extending `apps/web/src/multitable/utils/meta-automation-labels.ts`; no new DingTalk-specific module. |
| Primary surfaces | DingTalk shared chrome across `MetaAutomationManager.vue`, `MetaAutomationRuleEditor.vue`, and `dingtalk*.ts` utilities. |
| Scope | DingTalk group/person config chrome, template tokens, template warnings, link warnings/access summaries, recipient field warnings, preview labels, copy states, and the 16 zh-only DingTalk placeholders found by latest scout. |
| Preset templates | Localize generated default preset content at click time. These strings become user-editable template content after insertion and do not retranslate after locale toggle. |
| Template examples | Localize sample render data via `renderDingTalkTemplateExample(template, isZh)`; user template text and token names stay raw. |
| Utility signatures | Existing warning/access utilities gain locale options or optional `isZh` parameters while preserving EN as the default for direct utility tests. |
| A11y boundary | Localize existing placeholder text only; do not add new `aria-label`, `title`, or `placeholder` attributes. Fixture sentinel counts must stay stable. |
| Defer | Backend/API contract, DingTalk delivery runtime behavior, K3, attendance, non-DingTalk automation chrome, and final global audit. |

This preserves the parent T3D split:

- T3D-1 shipped: log viewer + delivery viewers.
- T3D-2 shipped: rule editor core.
- T3D-3 shipped: manager shell/cards/quick form.
- T3D-4: DingTalk shared chrome across manager + rule editor.

## 2. Scout Snapshot

Real source:

| File | Role |
| --- | --- |
| `MetaAutomationManager.vue` | Legacy quick form DingTalk group/person panels, previews, copy controls, card link utilities. |
| `MetaAutomationRuleEditor.vue` | Full rule editor DingTalk group/person panels, previews, copy controls. |
| `dingtalkNotificationPresets.ts` | Preset-generated title/body templates, currently zh-only. |
| `dingtalkNotificationTemplateExample.ts` | Rendered preview sample data, currently zh-only sample fields. |
| `dingtalkNotificationTemplateLint.ts` | Template syntax warning copy. |
| `dingtalkNotificationTemplateTokens.ts` | Token button labels and raw token values. |
| `dingtalkPublicFormLinkWarnings.ts` | Public-form access/audience summaries, blocking errors, and risk warnings. |
| `dingtalkInternalViewLinkWarnings.ts` | Internal-view link blocking warning. |
| `dingtalkRecipientFieldWarnings.ts` | Dynamic record-field warning copy for group/person destinations. |

Source attribute counts after T3D-3:

| Component | `aria-label=` | `title=` | `placeholder=` | T3D-4 rule |
| --- | ---: | ---: | ---: | --- |
| `MetaAutomationManager.vue` | 0 | 0 | 13 | Localize existing placeholder text only; fixture count stays stable. |
| `MetaAutomationRuleEditor.vue` | 0 | 5 | 25 | Localize existing DingTalk placeholders only; do not add attributes. |

Existing tests to extend:

| File | Existing role |
| --- | --- |
| `meta-automation-labels.spec.ts` | T3D helper unit and ALL_KEYS coverage. |
| `multitable-automation-manager.spec.ts` | Manager behavior, DingTalk quick-form coverage, card link summaries. |
| `multitable-automation-rule-editor.spec.ts` | Rule editor DingTalk group/person behavior and warnings. |
| `dingtalk-public-form-link-warnings.spec.ts` | Public-form access/warning utility tests. |
| `dingtalk-recipient-field-warnings.spec.ts` | Recipient field warning utility tests. |
| `dingtalk-internal-view-link-warnings.spec.ts` | Internal-view warning utility tests. |

## 3. Files In Scope

Implementation files:

| File | Change |
| --- | --- |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | Add DingTalk static keys, typed unions, and helper functions. |
| `apps/web/src/multitable/utils/dingtalkNotificationPresets.ts` | Generate locale-aware default title/body templates. |
| `apps/web/src/multitable/utils/dingtalkNotificationTemplateExample.ts` | Render preview examples using locale-aware sample data. |
| `apps/web/src/multitable/utils/dingtalkNotificationTemplateLint.ts` | Localize template syntax warnings. |
| `apps/web/src/multitable/utils/dingtalkNotificationTemplateTokens.ts` | Keep token values raw and expose localized token labels. |
| `apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts` | Localize access summaries, audience summaries, blocking errors, and risk warnings. |
| `apps/web/src/multitable/utils/dingtalkInternalViewLinkWarnings.ts` | Localize internal-view missing warning. |
| `apps/web/src/multitable/utils/dingtalkRecipientFieldWarnings.ts` | Localize dynamic recipient field warnings. |
| `apps/web/src/multitable/components/MetaAutomationManager.vue` | Wire Manager DingTalk panel chrome and pass `isZh.value` into shared utilities. |
| `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` | Wire RuleEditor DingTalk panel chrome and pass `isZh.value` into shared utilities. |

Test files:

| File | Change |
| --- | --- |
| `apps/web/tests/meta-automation-labels.spec.ts` | Add helper tests, typed discriminator fallbacks, zh/en baseline, ALL_KEYS lockstep. |
| `apps/web/tests/multitable-automation-manager.spec.ts` | Add zh DingTalk manager render assertions, raw selector checks, a11y sentinels. |
| `apps/web/tests/multitable-automation-rule-editor.spec.ts` | Add zh DingTalk rule editor render assertions, raw selector checks, a11y sentinels. |
| `apps/web/tests/dingtalk-public-form-link-warnings.spec.ts` | Add zh cases while preserving EN default behavior. |
| `apps/web/tests/dingtalk-recipient-field-warnings.spec.ts` | Add zh cases and raw field-path preservation. |
| `apps/web/tests/dingtalk-internal-view-link-warnings.spec.ts` | Add zh cases and raw view ID preservation. |

Docs:

| File | Change |
| --- | --- |
| `docs/development/multitable-t3d4-automation-dingtalk-i18n-design-20260522.md` | This design. |
| `docs/development/multitable-t3d4-automation-dingtalk-i18n-verification-20260522.md` | Implementation evidence. |

Out of scope:

| Surface | Reason |
| --- | --- |
| Automation backend/API/runtime delivery | T3D is frontend i18n only. |
| Non-DingTalk rule editor/manager chrome | Already covered by T3D-2/T3D-3. |
| `data-*` selector values and CSS enum suffixes | Raw selectors must remain stable. |
| User-authored template content after preset insertion | The generated default is localized at click time; later edits are user data. |
| Final global audit | Runs after T3D-4. |

## 4. Exact Chrome Targets

### 4.1 Shared Presets And Group Destination Chrome

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| Manager L110 / RuleEditor L309 | `Message preset` | `消息预设` | `dingtalk.preset` |
| Manager L111 / RuleEditor L310 | `Form request` | `表单填写` | `automationDingTalkPresetLabel('form_request', isZh)` |
| Manager L112 / RuleEditor L311 | `Internal processing` | `内部处理` | `automationDingTalkPresetLabel('internal_process', isZh)` |
| Manager L113 / RuleEditor L312 | `Form + processing` | `表单 + 处理` | `automationDingTalkPresetLabel('form_and_process', isZh)` |
| Manager L115 / RuleEditor group branch | `Add DingTalk groups` | `添加钉钉群` | `dingtalk.addGroups` |
| Manager L126 / RuleEditor L331 | `-- add DingTalk group --` | `-- 添加钉钉群 --` | `dingtalk.addGroupOption` |
| Manager/RuleEditor scope functions | `Organization catalog` / `This table` / `Private` | `组织目录` / `本表` / `私有` | `automationDingTalkDestinationScopeLabel(...)` |
| Manager/RuleEditor subtitles | `organization catalog: ${id}` / `sheet: ${id}` / `private` | `组织目录：${id}` / `表：${id}` / `私有` | `automationDingTalkDestinationSubtitle(...)` |
| Manager/RuleEditor empty state | `No DingTalk groups are available...` | `此表暂无可用钉钉群。请在 API Token 与 Webhook > 钉钉群中添加，或让管理员共享组织目录群，也可使用下方记录群字段路径。` | `dingtalk.noGroupsAvailable` |
| Chips | `Remove` | `移除` | `dingtalk.remove` |
| Manager L151 / RuleEditor L357 | `Record group field paths (optional)` | `记录群字段路径（可选）` | `dingtalk.recordGroupFieldPaths` |
| RuleEditor L375 hint | `Use record fields whose value...` | `使用值为钉钉群目标 ID 的记录字段，不要使用本地用户、成员组或钉钉群名称。` | `dingtalk.recordGroupFieldPathHint` |
| Manager L159 / RuleEditor L377 | `Pick group field` | `选择群字段` | `dingtalk.pickGroupField` |
| Manager L164 / RuleEditor L383 | `-- pick field --` | `-- 选择字段 --` | `dingtalk.pickFieldOption` |

### 4.2 Person Recipient Chrome

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| Manager L292 / RuleEditor L562 | `Search and add users or member groups` | `搜索并添加用户或成员组` | `dingtalk.searchUsersOrGroups` |
| Manager L300 / RuleEditor L567 | `Search by user, member group, email, or subject ID` | `按用户、成员组、邮箱或主体 ID 搜索` | `dingtalk.searchUsersOrGroupsPlaceholder` |
| Manager/RuleEditor loading | `Searching users and member groups...` | `正在搜索用户和成员组...` | `dingtalk.searchingUsersOrGroups` |
| Manager/RuleEditor empty | `No matching users or member groups` | `没有匹配的用户或成员组` | `dingtalk.noMatchingUsersOrGroups` |
| Manager/RuleEditor inactive candidate | `Inactive users cannot be added` | `不能添加已停用用户` | new `dingtalk.inactiveUsersCannotBeAdded` |
| Manager/RuleEditor subject | `User` / `Member group` | `用户` / `成员组` | `automationDingTalkPersonSubjectLabel(...)` |
| Manager/RuleEditor access | `Access: ${accessLevel}` | `权限：${accessLevel}` | `automationDingTalkPersonAccessLabel(...)` |
| Manager/RuleEditor status branches | see status table below | see status table below | `automationDingTalkPersonStatusLabel(...)` |
| Manager L356 / RuleEditor L623 | `Local user IDs` | `本地用户 ID` | `dingtalk.localUserIds` |
| Manager L365 / RuleEditor L632 | `Member group IDs (optional)` | `成员组 ID（可选）` | `dingtalk.memberGroupIds` |
| Manager L374 / RuleEditor L641 | `Record recipient field paths (optional)` | `记录收件人字段路径（可选）` | `dingtalk.recordRecipientFieldPaths` |
| Manager L380 / RuleEditor L649 | `Pick recipient field` | `选择收件人字段` | `dingtalk.pickRecipientField` |
| Manager/RuleEditor option | `-- choose a user field --` | `-- 选择用户字段 --` | `dingtalk.chooseUserFieldOption` |
| Manager/RuleEditor hint | `Record data is keyed by field ID...` | `记录数据以字段 ID 为键。请使用逗号或换行分隔的 record.<fieldId> 路径。选择器仅列出用户字段。` | `dingtalk.recordRecipientFieldPathHint` |
| Manager L419 / RuleEditor L686 | `Record member group field paths (optional)` | `记录成员组字段路径（可选）` | `dingtalk.recordMemberGroupFieldPaths` |
| Manager L425 / RuleEditor L694 | `Pick member group field` | `选择成员组字段` | `dingtalk.pickMemberGroupField` |
| Manager/RuleEditor option | `-- choose a member group field --` | `-- 选择成员组字段 --` | `dingtalk.chooseMemberGroupFieldOption` |
| Manager/RuleEditor hint | `Use comma or newline separated record.<fieldId> paths...` | `使用逗号或换行分隔的 record.<fieldId> 路径，字段值应解析为成员组 ID。选择器仅列出显式成员组字段。` | `dingtalk.recordMemberGroupFieldPathHint` |

Person delivery status branches are shared by Manager and RuleEditor and must be enumerated, not left as prose:

| Status | Current EN | Target zh |
| --- | --- | --- |
| `memberGroupCheckedIndividually` | `Member group members are checked individually for DingTalk delivery` | `成员组成员会逐个检查钉钉投递条件` |
| `noDeliveryLink` | `No DingTalk delivery link; person message will skip until linked` | `无钉钉投递关联；关联前个人消息会跳过` |
| `deliveryReadyGrantEnabled` | `DingTalk direct message ready; form authorization enabled` | `钉钉直接消息已就绪；表单授权已启用` |
| `deliveryReadyGrantDisabled` | `DingTalk direct message ready; form authorization not enabled` | `钉钉直接消息已就绪；表单授权未启用` |
| `notBound` | `Not bound to DingTalk; person message may skip until linked` | `未绑定钉钉；关联前个人消息可能跳过` |
| `boundGrantEnabled` | `DingTalk bound; form authorization enabled` | `已绑定钉钉；表单授权已启用` |
| `boundGrantDisabled` | `DingTalk bound; form authorization not enabled` | `已绑定钉钉；表单授权未启用` |

### 4.3 Template, Token, Preview, And Copy Chrome

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| Manager/RuleEditor | `Title template` | `标题模板` | `dingtalk.titleTemplate` |
| Manager/RuleEditor | `Body template` | `正文模板` | `dingtalk.bodyTemplate` |
| Manager/RuleEditor | `Template tokens` | `模板令牌` | `dingtalk.templateTokens` |
| `DINGTALK_*_TEMPLATE_TOKENS` | `Record ID` / `Sheet ID` / `Actor ID` / `Record field` | `记录 ID` / `表 ID` / `触发人 ID` / `记录字段` | `automationDingTalkTemplateTokenLabel(...)` |
| Manager/RuleEditor | `Public form view (optional)` | `公开表单视图（可选）` | `dingtalk.publicFormView` |
| Manager/RuleEditor | `-- no public form link --` | `-- 无公开表单链接 --` | `dingtalk.noPublicFormLinkOption` |
| Manager/RuleEditor | `Internal processing view (optional)` | `内部处理视图（可选）` | `dingtalk.internalProcessingView` |
| Manager/RuleEditor | `-- no internal link --` | `-- 无内部链接 --` | `dingtalk.noInternalLinkOption` |
| Manager/RuleEditor | `Message summary` | `消息摘要` | `dingtalk.messageSummary` |
| Manager/RuleEditor labels | `Groups`, `Record groups`, `Recipients`, `Record recipients`, `Record member groups` | `群`, `记录群`, `收件人`, `记录收件人`, `记录成员组` | static keys |
| Manager/RuleEditor labels | `Title template`, `Body template`, `Rendered title`, `Rendered body` | `标题模板`, `正文模板`, `渲染标题`, `渲染正文` | static keys |
| Manager/RuleEditor fallbacks | `No groups selected`, `No recipients selected`, `No dynamic ...`, `No title template`, `No rendered body` | localized fallback strings | static keys |
| Manager/RuleEditor buttons | `Copy` / `Copied` | `复制` / `已复制` | `dingtalk.copy`, `dingtalk.copied` |
| Manager/RuleEditor labels | `Public form`, `Public form access`, `Allowed audience`, `Internal processing` | `公开表单`, `公开表单访问`, `允许范围`, `内部处理` | static keys |

Implementation note: field names, view names, destination names, and rendered template output are raw interpolated values. Only the surrounding chrome is localized.

### 4.4 zh-only Placeholder Targets

Latest grep found 16 zh-only DingTalk placeholders, not the earlier 14-count reminder. T3D-4 owns all 16.

| File:line | Current zh placeholder | Target en placeholder | Key/helper |
| --- | --- | --- | --- |
| `MetaAutomationManager.vue:169` | `例如：{{record.title}} 待处理` | `Example: {{record.title}} needs attention` | `dingtalk.titleTemplatePlaceholder` |
| `MetaAutomationManager.vue:197` | `支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}` | `Supports {{record.xxx}}, {{recordId}}, {{sheetId}}, and {{actorId}}` | `dingtalk.bodyTemplatePlaceholder` |
| `MetaAutomationManager.vue:360` | `使用逗号或换行分隔本地 userId` | `Use comma or newline separated local user IDs` | `dingtalk.localUserIdsPlaceholder` |
| `MetaAutomationManager.vue:368` | `使用逗号或换行分隔成员组 ID` | `Use comma or newline separated member group IDs` | `dingtalk.memberGroupIdsPlaceholder` |
| `MetaAutomationManager.vue:376` | `例如：record.assigneeUserIds, record.reviewerUserId` | `Example: record.assigneeUserIds, record.reviewerUserId` | `dingtalk.recordRecipientFieldPathPlaceholder` |
| `MetaAutomationManager.vue:421` | `例如：record.watcherGroupIds, record.escalationGroupId` | `Example: record.watcherGroupIds, record.escalationGroupId` | `dingtalk.recordMemberGroupFieldPathPlaceholder` |
| `MetaAutomationManager.vue:466` | `例如：{{record.title}} 待处理` | `Example: {{record.title}} needs attention` | `dingtalk.titleTemplatePlaceholder` |
| `MetaAutomationManager.vue:494` | `支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}` | `Supports {{record.xxx}}, {{recordId}}, {{sheetId}}, and {{actorId}}` | `dingtalk.bodyTemplatePlaceholder` |
| `MetaAutomationRuleEditor.vue:415` | `例如：{{record.title}} 待处理` | `Example: {{record.title}} needs attention` | `dingtalk.titleTemplatePlaceholder` |
| `MetaAutomationRuleEditor.vue:443` | `支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}` | `Supports {{record.xxx}}, {{recordId}}, {{sheetId}}, and {{actorId}}` | `dingtalk.bodyTemplatePlaceholder` |
| `MetaAutomationRuleEditor.vue:627` | `使用逗号或换行分隔本地 userId` | `Use comma or newline separated local user IDs` | `dingtalk.localUserIdsPlaceholder` |
| `MetaAutomationRuleEditor.vue:635` | `使用逗号或换行分隔成员组 ID` | `Use comma or newline separated member group IDs` | `dingtalk.memberGroupIdsPlaceholder` |
| `MetaAutomationRuleEditor.vue:643` | `例如：record.assigneeUserIds, record.reviewerUserId` | `Example: record.assigneeUserIds, record.reviewerUserId` | `dingtalk.recordRecipientFieldPathPlaceholder` |
| `MetaAutomationRuleEditor.vue:688` | `例如：record.watcherGroupIds, record.escalationGroupId` | `Example: record.watcherGroupIds, record.escalationGroupId` | `dingtalk.recordMemberGroupFieldPathPlaceholder` |
| `MetaAutomationRuleEditor.vue:733` | `例如：{{record.title}} 待处理` | `Example: {{record.title}} needs attention` | `dingtalk.titleTemplatePlaceholder` |
| `MetaAutomationRuleEditor.vue:761` | `支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}` | `Supports {{record.xxx}}, {{recordId}}, {{sheetId}}, and {{actorId}}` | `dingtalk.bodyTemplatePlaceholder` |

### 4.5 Preset-Generated Template Content

`applyDingTalkNotificationPreset(...)` currently inserts zh-only template content. T3D-4 localizes this generated default content at click time:

| Preset | EN title/body | zh title/body |
| --- | --- | --- |
| `form_request` | `{{recordId}} needs input` / `Please complete this form request.\nRecord ID: {{recordId}}\nActor: {{actorId}}` | existing `{{recordId}} 待填写` / `请完成本次表单填写。\n记录编号：{{recordId}}\n触发人：{{actorId}}` |
| `internal_process` | `{{recordId}} needs processing` / `Please review and process this record.\nRecord ID: {{recordId}}\nActor: {{actorId}}` | existing `{{recordId}} 待处理` / `请查看并处理该记录。\n记录编号：{{recordId}}\n触发人：{{actorId}}` |
| `form_and_process` | `{{recordId}} needs input and processing` / `Please complete the required form input, then continue processing this record.\nRecord ID: {{recordId}}\nActor: {{actorId}}` | existing `{{recordId}} 待填写并处理` / `请先填写所需信息，并由有权限成员继续处理该记录。\n记录编号：{{recordId}}\n触发人：{{actorId}}` |

This is event-time behavior. Once the preset writes `titleTemplate` / `bodyTemplate` into the draft, that content is user-editable data and does not retranslate if locale changes.

### 4.6 Utility Warning And Access Summary Chrome

These utility functions must become locale-aware and keep raw identifiers interpolated:

| Utility | Current EN class | Target |
| --- | --- | --- |
| `listDingTalkTemplateSyntaxWarnings(template, isZh)` | Empty/unsupported/unknown/unclosed placeholder warnings | Localize wrapper text; keep `${raw}` placeholder raw. |
| `listDingTalkGroupDestinationFieldPathWarnings(value, fields, isZh)` | unknown/user/member-group wrong-type warnings | Localize wrapper text; keep `record.${path}` raw. |
| `listDingTalkPersonRecipientFieldPathWarnings(value, fields, isZh)` | not user field warnings | Localize wrapper text; keep `record.${path}` raw. |
| `listDingTalkPersonMemberGroupRecipientFieldPathWarnings(value, fields, isZh)` | unknown/user/not member-group warnings | Localize wrapper text; keep `record.${path}` raw. |
| `describeDingTalkPublicFormLinkAccess(..., { isZh })` | access state summaries | Localize wrapper text; keep view names raw. |
| `describeDingTalkPublicFormLinkAudience(..., { isZh })` | audience summaries and allowlist counts | Localize wrapper text and plural/count wording; keep counts raw. |
| `listDingTalkPublicFormLinkBlockingErrors(..., { isZh })` | missing/disabled/expired form errors | Localize wrapper text; keep view IDs/names raw. |
| `listDingTalkPublicFormLinkWarnings(..., { isZh })` | fully public / protected-without-allowlist risk warnings | Localize wrapper text; keep view names raw. |
| `listDingTalkInternalViewLinkWarnings(viewId, views, isZh)` | missing internal-view warning | Localize wrapper text; keep view ID raw. |

For `dingtalkPublicFormLinkWarnings.ts`, prefer extending `DingTalkPublicFormLinkWarningOptions` with `isZh?: boolean` rather than adding positional booleans. This preserves the existing `nowMs` number shorthand in tests and avoids call-site ambiguity.

## 5. Label Module Additions

Continue the T3D single-domain module:

```ts
export type AutomationDingTalkPreset = 'form_request' | 'internal_process' | 'form_and_process'
export type AutomationDingTalkTemplateTokenKey = 'recordId' | 'sheetId' | 'actorId' | 'recordField'
export type AutomationDingTalkDestinationScope = 'private' | 'sheet' | 'org'
export type AutomationDingTalkPersonSubject = 'user' | 'member-group'
export type AutomationDingTalkPersonStatus =
  | 'memberGroupCheckedIndividually'
  | 'noDeliveryLink'
  | 'deliveryReadyGrantEnabled'
  | 'deliveryReadyGrantDisabled'
  | 'notBound'
  | 'boundGrantEnabled'
  | 'boundGrantDisabled'

export function automationDingTalkPresetLabel(preset: AutomationDingTalkPreset | (string & {}), isZh: boolean): string
export function automationDingTalkTemplateTokenLabel(token: AutomationDingTalkTemplateTokenKey | (string & {}), isZh: boolean): string
export function automationDingTalkDestinationScopeLabel(scope: AutomationDingTalkDestinationScope | (string & {}), isZh: boolean): string
export function automationDingTalkDestinationSubtitle(scope: AutomationDingTalkDestinationScope, id: string, isZh: boolean): string
export function automationDingTalkPersonSubjectLabel(subject: AutomationDingTalkPersonSubject | (string & {}), isZh: boolean): string
export function automationDingTalkPersonAccessLabel(accessLevel: string, isZh: boolean): string
export function automationDingTalkPersonStatusLabel(status: AutomationDingTalkPersonStatus | (string & {}), isZh: boolean): string
export function automationDingTalkAllowlistSummary(userCount: number, memberGroupCount: number, isZh: boolean): string
```

`automationDingTalkAllowlistSummary(0, 0, isZh)` returns an empty string. Callers must use the existing no-allowlist full-sentence branches for the zero case; the helper only formats non-empty allowlist count summaries.

Static keys should use a `dingtalk.*` namespace inside `AutomationLabelKey`, for example:

| Namespace | Examples |
| --- | --- |
| `dingtalk.preset.*` | `dingtalk.preset`, `dingtalk.formRequest`, `dingtalk.internalProcessing`, `dingtalk.formAndProcessing`. |
| `dingtalk.group.*` | `dingtalk.addGroups`, `dingtalk.recordGroupFieldPaths`, `dingtalk.pickGroupField`. |
| `dingtalk.person.*` | `dingtalk.searchUsersOrGroups`, `dingtalk.localUserIds`, `dingtalk.recordRecipientFieldPaths`. |
| `dingtalk.template.*` | `dingtalk.titleTemplate`, `dingtalk.bodyTemplate`, `dingtalk.templateTokens`, placeholders. |
| `dingtalk.preview.*` | `dingtalk.messageSummary`, `dingtalk.renderedTitle`, `dingtalk.noRenderedBody`, `dingtalk.copy`, `dingtalk.copied`. |
| `dingtalk.link.*` | `dingtalk.publicFormView`, `dingtalk.publicFormAccess`, `dingtalk.allowedAudience`, `dingtalk.internalProcessingView`. |

Unknown enum/helper values must fall back to `String(value)`.

## 6. Raw Boundary

Keep these raw:

| Raw value | Reason |
| --- | --- |
| `data-*` selector values such as `data-field`, `data-automation-token`, `data-access-level` | Test/CSS selectors and persisted enum state. |
| CSS suffixes from access levels (`public`, `dingtalk`, `dingtalk_granted`, etc.) | Styling contract. |
| DingTalk destination IDs, user IDs, member group IDs, subject IDs | User/system data. |
| Field IDs and field paths such as `record.assigneeUserIds` | User schema data and template syntax. |
| Field names and view names | User-authored data. |
| Template token values such as `{{recordId}}`, `{{record.xxx}}` | Technical syntax. |
| User-authored title/body templates after preset insertion | Data, not chrome. |
| Rendered template output | Derived from user template plus sample/user data. |
| Backend/API errors and `e.message` | Raw error detail; only frontend fallback wrappers are localized. |
| Public token / access mode persisted values | Contract data. |

M1 trap guard: localized strings must never be assigned to `data-*` attributes or CSS suffixes. Bind raw values only.

## 7. A11y Boundary

T3D-4 localizes existing placeholder text, but must not add new a11y attributes.

| Component | Source `aria-label` | Source `title` | Source `placeholder` | Expected |
| --- | ---: | ---: | ---: | --- |
| `MetaAutomationManager.vue` | 0 | 0 | 13 | Fixture-render count remains stable; placeholder count stays unchanged. |
| `MetaAutomationRuleEditor.vue` | 0 | 5 | 25 | Fixture-render count remains stable; placeholder count stays unchanged. |

Implementation specs must record fixture-render counts for `[aria-label]`, `[title]`, and `[placeholder]` after wiring. Text changes to existing placeholders are required i18n behavior; adding new attributes is out of scope.

## 8. Test Plan

### 8.1 Helper Unit Tests

Extend `apps/web/tests/meta-automation-labels.spec.ts`:

- All new `dingtalk.*` keys included in `AUTOMATION_LABEL_KEYS`.
- Preset labels in en/zh plus unknown fallback.
- Template token labels in en/zh plus unknown fallback.
- Destination scope labels/subtitles in en/zh, preserving raw IDs.
- Person subject/access/status labels in en/zh, preserving raw access levels.
- Allowlist count summaries:
  - both-zero returns `''`
  - `1 local user`
  - `2 local users`
  - `1 local member group`
  - mixed user + group
  - zh count forms with no EN plural suffix.

### 8.2 Utility Tests

Extend existing utility specs:

- `dingtalk-public-form-link-warnings.spec.ts`: keep current EN default expectations; add zh cases using `{ nowMs, isZh: true }`.
- `dingtalk-recipient-field-warnings.spec.ts`: keep current EN default expectations; add zh cases and assert `record.${path}` remains raw.
- `dingtalk-internal-view-link-warnings.spec.ts`: keep current EN default expectations; add zh case and assert missing view ID remains raw.
- Do not add dedicated specs for `dingtalkNotificationTemplateLint.ts`, `dingtalkNotificationTemplateTokens.ts`, `dingtalkNotificationPresets.ts`, or `dingtalkNotificationTemplateExample.ts` in this slice. Their locale behavior is covered through Manager/RuleEditor render specs that exercise the actual call-sites, plus `meta-automation-labels.spec.ts` helper coverage. If implementation later chooses to add a small dedicated spec for debugging, it is additive but not required by this design.

### 8.3 Manager Render Tests

Extend `apps/web/tests/multitable-automation-manager.spec.ts`:

- zh-CN quick-form DingTalk group panel: preset buttons, group picker, template token buttons, preview labels, link labels, copy/copy-state.
- zh-CN quick-form DingTalk person panel: search labels, recipient labels/statuses, placeholders, field-picker labels, preview labels.
- Raw selector checks:
  - `data-automation-token` values stay token keys.
  - `data-access-level` values stay raw access levels.
  - field/view/destination IDs remain raw in selectors.
- A11y sentinel: fixture-render `[aria-label]`, `[title]`, `[placeholder]` counts remain stable.

### 8.4 Rule Editor Render Tests

Extend `apps/web/tests/multitable-automation-rule-editor.spec.ts`:

- zh-CN group action config: preset buttons, dynamic group field chrome, warnings, template tokens, public/internal link labels, preview labels.
- zh-CN person action config: search and recipient chrome, warnings, template tokens, public/internal link labels, preview labels.
- Utility warning rendering in zh, with raw field paths and view names preserved.
- A11y sentinel: fixture-render `[aria-label]`, `[title]`, `[placeholder]` counts remain stable.

### 8.5 Validation Commands

Run package-relative paths because `pnpm --filter @metasheet/web exec` runs with `cwd=apps/web`:

```bash
pnpm --filter @metasheet/web exec vitest run tests/meta-automation-labels.spec.ts tests/dingtalk-public-form-link-warnings.spec.ts tests/dingtalk-recipient-field-warnings.spec.ts tests/dingtalk-internal-view-link-warnings.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

## 9. Preflight Grep

Before implementation, run:

```bash
rg -n "Message preset|Form request|Form \\+ processing|Add DingTalk groups|Template tokens|Public form view|Internal processing view|Message summary|Rendered title|Rendered body|No public form link|No internal link|Search by user|No matching users|Inactive users cannot be added|record\\.opsDestinationId|例如：\\{\\{record\\.title\\}\\}|支持 \\{\\{record\\.xxx\\}\\}|使用逗号或换行分隔" apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/src/multitable/components/MetaAutomationRuleEditor.vue
rg -n "Empty placeholder|Unsupported placeholder|Unknown placeholder|Unclosed placeholder|No public form link|Allowed audience unavailable|Public form sharing|Internal processing view|not a user field|not a member group field|member group recipients expect" apps/web/src/multitable/utils/dingtalk*.ts
```

Classify each hit as:

- `localize`: DingTalk chrome or frontend static fallback.
- `raw`: user data, token syntax, ID, selector, enum, or backend error.
- `already shipped`: non-DingTalk automation chrome from T3D-1/T3D-2/T3D-3.

Verification MD must include the grep output or a summarized table with line references.

## 10. Implementation Order

1. Rebase onto current `origin/main` before writing code.
2. Run the §9 preflight grep and update the implementation checklist if new call-sites appear.
3. Extend `meta-automation-labels.ts` with `dingtalk.*` keys, typed unions, and helpers.
4. Update token utilities so token values stay raw and labels render through locale-aware helpers.
5. Update preset/template-example utilities with locale-aware generated defaults and sample data.
6. Update template lint, recipient warning, internal-view warning, and public-form warning utilities with locale-aware output.
7. Wire `MetaAutomationManager.vue` with `isZh.value`; do not touch non-DingTalk chrome.
8. Wire `MetaAutomationRuleEditor.vue` with `isZh.value`; do not touch non-DingTalk chrome.
9. Extend helper and utility specs.
10. Extend manager and rule editor render specs with zh/en/raw/a11y sentinel assertions.
11. Write verification MD with preflight grep evidence, reuse-grep evidence, test output, a11y counts, raw boundary notes, and known limitations.
12. Run targeted tests, `vue-tsc`, build, and diff-check.
13. Commit locally and stop before push.

## 11. Risk Register

| Risk | Mitigation |
| --- | --- |
| Locale-aware utility signatures break existing tests | Keep EN default behavior for direct utility calls; call sites pass `isZh.value` explicitly. |
| Preset-generated templates become user data after insertion | Document event-time semantics; do not try to retranslate edited templates. |
| Public-form warning options overload becomes ambiguous | Add `isZh?: boolean` to the existing options object; preserve numeric `nowMs` shorthand. |
| Template token labels accidentally translate token values | Keep `value` raw and localize only labels. |
| CSS/data selector trap | Assert raw `data-*` and access-level values in render specs. |
| A11y attribute drift | Lock fixture-render `[aria-label]`, `[title]`, and `[placeholder]` counts. |
| 4-PR chain mid-flight rebase | For T3D-4, fetch/rebase before push. If PR becomes BEHIND with zero surface overlap, Path A admin squash remains acceptable; otherwise rebase and `--force-with-lease`. |
| Existing DingTalk specs assert EN strings | Update expectations lockstep and add zh cases; keep EN default utility tests where default behavior remains EN. |

## 12. Approval Gate

Implementation is ready to push only if:

- No backend, contract, migration, attendance, K3, or non-DingTalk automation scope leaks.
- `meta-automation-labels.ts` is the only label module touched.
- Every new key/helper has a real call-site or direct utility spec consumer.
- `data-*`, CSS suffixes, IDs, token values, field paths, view names, destination names, and backend errors stay raw.
- Manager and RuleEditor specs include zh render checks plus raw selector checks.
- A11y sentinel counts are recorded and stable.
- Targeted vitest, `vue-tsc`, build, and `git diff --check` pass.
