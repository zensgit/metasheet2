# Multitable T3D Automation I18n Design (2026-05-21)

## 1. Decision Summary

T3D is the remaining automation surface after T3A/T3B/T3C/T3E landed. The scout shows it is materially larger than the prior cleanup slices:

| Surface | File | Size | Main i18n risk |
| --- | --- | ---: | --- |
| Automation manager | `MetaAutomationManager.vue` | 2,283 lines | Legacy quick form, rule cards, DingTalk preview strings, dynamic summaries |
| Rule editor | `MetaAutomationRuleEditor.vue` | 2,748 lines | Trigger/action/condition enums, nested condition builder, DingTalk action config |
| Log viewer | `MetaAutomationLogViewer.vue` | 423 lines | Status/action labels, support packet status, redaction boundary |
| Group deliveries | `MetaAutomationGroupDeliveryViewer.vue` | 269 lines | Delivery status chrome, error fallback |
| Person deliveries | `MetaAutomationPersonDeliveryViewer.vue` | 322 lines | Success/failed/skipped labels, inactive-user chrome |
| Shared DingTalk helpers | `dingtalk*.ts` utils | 6 files | Warning strings, template token labels, access summaries |

Recommended implementation shape: split T3D into four PRs. This keeps each review small while preserving a single automation-domain label module.

| Slice | Scope | Rationale |
| --- | --- | --- |
| T3D-1 | `meta-automation-labels.ts` foundation + log viewer + group/person delivery viewers | Lowest coupling; validates enum label helpers, redaction boundary, and status raw/data split first. |
| T3D-2 | `MetaAutomationRuleEditor.vue` core editor | Largest enum-heavy surface; should land alone. Includes trigger/action/condition/operator labels and non-DingTalk action chrome. |
| T3D-3 | `MetaAutomationManager.vue` shell/card/legacy quick form | Parent manager has separate card summaries and legacy form semantics; separate from rule editor to avoid a 5k-line review. |
| T3D-4 | DingTalk automation shared chrome and helper utilities | Template token labels, warning helpers, public/internal link access summaries, preset buttons, preview labels across manager + rule editor. |

Design choice: create `apps/web/src/multitable/utils/meta-automation-labels.ts` and extend it across all T3D sub-slices. Automation is a single domain with shared persisted enums and shared DingTalk copy, so a per-component module would duplicate trigger/action/status helpers. This differs from T3C per-manager modules because automation rule editor, manager cards, logs, and delivery viewers all render the same rule/action/status concepts.

## 2. Files In Scope

T3D-1 in scope:

| File | Change |
| --- | --- |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | New typed label module; initial status/action/log/delivery helpers. |
| `apps/web/src/multitable/components/MetaAutomationLogViewer.vue` | Localize visible chrome; keep redacted content raw. |
| `apps/web/src/multitable/components/MetaAutomationGroupDeliveryViewer.vue` | Localize delivery viewer chrome and status labels. |
| `apps/web/src/multitable/components/MetaAutomationPersonDeliveryViewer.vue` | Localize delivery viewer chrome and status labels. |
| `apps/web/tests/meta-automation-labels.spec.ts` | New helper spec. |
| `apps/web/tests/MetaAutomationLogViewer.spec.ts` | Extend existing spec for zh/en labels and raw-boundary checks. |
| `apps/web/tests/meta-automation-delivery-viewers-i18n.spec.ts` | New direct render spec for group/person delivery viewers. |
| `docs/development/multitable-t3d-automation-i18n-verification-20260521.md` | Verification report for T3D-1. |

T3D-2/T3D-3/T3D-4 deferred from the first PR but covered by this design:

| Surface | Files |
| --- | --- |
| Rule editor | `MetaAutomationRuleEditor.vue`, `multitable-automation-rule-editor.spec.ts` |
| Manager | `MetaAutomationManager.vue`, `multitable-automation-manager.spec.ts` |
| DingTalk helpers | `dingtalkNotificationTemplateTokens.ts`, `dingtalkNotificationTemplateLint.ts`, `dingtalkRecipientFieldWarnings.ts`, `dingtalkPublicFormLinkWarnings.ts`, `dingtalkInternalViewLinkWarnings.ts`, `dingtalkNotificationPresets.ts` |
| Automation composable fallbacks | `useMultitableAutomations.ts` |

Out of scope for all T3D slices:

| Area | Reason |
| --- | --- |
| Backend automation runtime | T3D is frontend i18n only. No contract/API/migration changes. |
| Automation execution behavior | Rule semantics, delivery behavior, log redaction logic, and support-packet payloads remain unchanged. |
| T3 final audit | Runs after T3D implementation. |
| K3/attendance/integration-core | K3 PoC stage-1 lock remains active. |

## 3. Label Module

New module:

```ts
// apps/web/src/multitable/utils/meta-automation-labels.ts
export type AutomationLabelKey = ...
export function automationLabel(key: AutomationLabelKey, isZh: boolean): string
export function automationStatusLabel(status: AutomationExecutionStatus, isZh: boolean): string
export function automationActionTypeLabel(type: AutomationActionType, isZh: boolean): string
export function automationTriggerTypeLabel(type: AutomationTriggerType, isZh: boolean): string
export function automationConditionOperatorLabel(op: ConditionOperator, isZh: boolean): string
export type AutomationConditionValueWidget =
  | 'text'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'boolean'
  | 'booleanMultiSelect'
  | 'select'
  | 'multiSelect'
export function automationConditionValuePlaceholder(widget: AutomationConditionValueWidget, isArray: boolean, isZh: boolean): string
```

The `AutomationConditionValueWidget` union mirrors the real `ConditionValueWidget` in `MetaAutomationRuleEditor.vue`: `text`, `number`, `date`, `dateTime`, `boolean`, `booleanMultiSelect`, `select`, and `multiSelect`. Do not accept free strings.

Initial T3D-1 key groups:

| Namespace | Examples |
| --- | --- |
| `log.*` | `log.title`, `log.total`, `log.success`, `log.failed`, `log.avgDuration`, `log.loading`, `log.empty`, `log.retry` |
| `status.*` | `status.all`, `status.success`, `status.failed`, `status.skipped` |
| `support.*` | `support.copyPacket`, `support.downloadJson`, `support.clipboardUnavailable`, `support.copied`, `support.copyFailed`, `support.downloaded`, `support.downloadFailed` |
| `delivery.*` | `delivery.groupTitle`, `delivery.personTitle`, `delivery.loading`, `delivery.emptyGroup`, `delivery.emptyPerson`, `delivery.refresh`, `delivery.inactiveUser`, `delivery.dingtalkPrefix` |
| `error.*` | `error.loadLogs`, `error.loadStats`, `error.loadGroupDeliveries`, `error.loadPersonDeliveries`, `error.unknown` |

Future T3D-2/T3D-3/T3D-4 key groups:

| Namespace | Examples |
| --- | --- |
| `manager.*` | `manager.title`, `manager.empty`, `manager.newAutomation`, `manager.quickLegacyForm`, `manager.enabled`, `manager.disabled` |
| `editor.*` | `editor.newTitle`, `editor.editTitle`, `editor.name`, `editor.save`, `editor.saving`, `editor.cancel`, `editor.testRun` |
| `trigger.*` | `trigger.recordCreated`, `trigger.recordUpdated`, `trigger.recordDeleted`, `trigger.fieldValueChanged`, `trigger.scheduleCron`, `trigger.scheduleInterval`, `trigger.webhookReceived`, legacy `trigger.fieldChanged` |
| `action.*` | `action.updateRecord`, `action.createRecord`, `action.sendWebhook`, `action.sendNotification`, `action.sendEmail`, `action.sendDingTalkGroup`, `action.sendDingTalkPerson`, `action.lockRecord`, legacy `action.notify`, `action.updateField` |
| `condition.*` | `condition.equals`, `condition.notEquals`, `condition.contains`, `condition.notContains`, `condition.greaterThan`, `condition.isEmpty`, etc. |
| `dingtalk.*` | preset buttons, recipient labels, template placeholders, dynamic warning fallbacks, preview labels |

Legacy `action.notify` and `action.updateField` keys coexist with the newer action keys for persisted legacy automation data and the manager quick legacy form. New V1 rule-editor actions use `action.sendNotification`, `action.updateRecord`, and related V1 keys; do not retire the legacy labels until the legacy quick form is removed.

No cross-module redeclare:

| Existing module | Rule |
| --- | --- |
| `meta-manager-labels.ts` | Do not add automation labels here, even if a word like `action.cancel` exists. Automation owns its own button labels because rule editor and manager do not import manager panels. |
| `meta-api-token-labels.ts` | Do not reuse DingTalk group labels from API token manager. API-token DingTalk group management and automation delivery config are separate consumer surfaces. |
| `workbench-labels.ts` | Do not add automation manager labels here. Workbench owns outer shell/toasts; automation modal owns its chrome. |
| `meta-core-labels.ts` | Do not add automation status/action enums here. Meta core remains grid/table/cell cross-surface infrastructure. |

## 4. Raw Boundary

Persisted values and user/admin-authored data stay raw. This is the most important T3D rule because existing specs heavily depend on raw selectors and enum values.

Always raw:

| Category | Examples |
| --- | --- |
| Persisted enums in values/config | `record.created`, `field.value_changed`, `send_dingtalk_group_message`, `equals`, `POST`, `success` |
| `data-*` and CSS-class suffixes | `:data-status="log.status"`, `:data-access-level="accessState.level"`, `meta-log-viewer__badge--${log.status}` |
| User/admin content | rule names, field names, view names, destination names, webhook URLs, email addresses, template bodies, notification messages |
| Identifiers | rule IDs, record IDs, sheet IDs, field IDs, user IDs, member group IDs, destination IDs |
| Backend/runtime error text | `error.message`, `errorMessage`, redacted step errors, support packet text |
| Redacted support output | Keep `summarizeStepError`, `summarizeStepOutput`, and support-packet payload content semantically unchanged. |

Visible enum labels may be localized only through helper functions with raw fallback:

```ts
automationActionTypeLabel(action.type, isZh.value) // known enum -> localized label, unknown -> String(type)
automationStatusLabel(log.status, isZh.value)      // visible badge text only
```

The raw selector must remain separate:

```vue
<span
  :class="`meta-log-viewer__badge--${log.status}`"
  :data-status="log.status"
>
  {{ automationStatusLabel(log.status, isZh) }}
</span>
```

## 5. Exact Chrome Targets

### 5.1 T3D-1: Log Viewer

Real source: `MetaAutomationLogViewer.vue`.

| Current EN | Proposed zh | Notes |
| --- | --- | --- |
| Execution Logs | 执行日志 | `log.title` |
| Total / Success / Failed / Avg duration | 总计 / 成功 / 失败 / 平均耗时 | stats labels |
| All statuses / Success / Failed / Skipped | 全部状态 / 成功 / 失败 / 跳过 | visible option labels; option values stay raw |
| Refresh | 刷新 | `delivery.refresh` or shared `log.refresh` |
| Failed to load logs: | 加载日志失败： | prefix only; `loadError` raw/redacted |
| Retry | 重试 | button |
| Loading logs... | 正在加载日志... | loading state |
| No execution logs found. | 暂无执行日志。 | empty state |
| Copy redacted packet | 复制脱敏包 | support action |
| Download JSON | 下载 JSON | support action |
| Clipboard unavailable | 剪贴板不可用 | thrown fallback |
| Redacted packet copied. | 已复制脱敏包。 | support status |
| Copy failed: `message` | 复制失败：`message` | `message` raw |
| Redacted JSON downloaded. | 已下载脱敏 JSON。 | support status |
| Download failed: `message` | 下载失败：`message` | `message` raw |
| Unknown error | 未知错误 | fallback only |

Status badges:

| Raw status | EN label | zh label |
| --- | --- | --- |
| `success` | success | 成功 |
| `failed` | failed | 失败 |
| `skipped` | skipped | 跳过 |

Action type labels inside step rows use `automationActionTypeLabel`. Unknown action types display raw `String(actionType)`.

### 5.2 T3D-1: Delivery Viewers

Real source: `MetaAutomationGroupDeliveryViewer.vue` and `MetaAutomationPersonDeliveryViewer.vue`.

| Current EN | Proposed zh | Notes |
| --- | --- | --- |
| DingTalk Group Deliveries | 钉钉群投递记录 | group title |
| DingTalk Person Deliveries | 钉钉个人投递记录 | person title |
| All statuses | 全部状态 | select option; value raw |
| Success / Failed / Skipped / unbound | 成功 / 失败 / 跳过 / 未绑定 | visible labels |
| Refresh | 刷新 | shared |
| Loading deliveries... | 正在加载投递记录... | loading state |
| No DingTalk group deliveries found. | 暂无钉钉群投递记录。 | empty group |
| No DingTalk person deliveries found. | 暂无钉钉个人投递记录。 | empty person |
| Inactive user | 已停用用户 | visible tag |
| DingTalk: `id` | 钉钉：`id` | prefix localized, ID raw |
| Failed to load DingTalk group deliveries. | 加载钉钉群投递记录失败。 | static fallback only; error.message wins |
| Failed to load DingTalk person deliveries. | 加载钉钉个人投递记录失败。 | static fallback only; error.message wins |
| DingTalk account is not linked or user is inactive | 钉钉账号未绑定或用户已停用 | This is a frontend sentinel constant; localize visible fallback but keep comparison against raw constant. |

### 5.3 T3D-2: Rule Editor

Real source: `MetaAutomationRuleEditor.vue`.

This slice is intentionally not part of T3D-1. It needs a dedicated PR because it includes nested condition groups, typed discriminator helpers, test-run confirmation, and action-specific config panels.

Representative target groups:

| Group | Examples |
| --- | --- |
| Shell | `Edit Automation Rule`, `New Automation Rule`, `Name`, `Automation name`, `Save`, `Saving...`, `Cancel`, `Test Run`, `Running...` |
| Trigger | `When record created`, `When record updated`, `When record deleted`, `When field value changed`, `Schedule (cron)`, `Schedule (interval)`, `Webhook received` |
| Schedule | `Preset`, `Every 5 minutes`, `Every hour`, `Daily at midnight`, `Weekly (Monday)`, `Custom`, `Cron expression`, `Interval (minutes)` |
| Conditions | `Conditions`, `(optional)`, `AND`, `OR`, `Group`, `+ Condition`, `+ Group`, `Remove group`, `Remove condition`, `Comma-separated values`, `Number`, `Date and time` |
| Operators | `Equals`, `Not equals`, `Contains`, `Not contains`, `Greater than`, `Less than`, `Greater or equal`, `Less or equal`, `Is empty`, `Is not empty`, `In list`, `Not in list` |
| Actions | `Update record`, `Create record`, `Send webhook`, `Send notification`, `Send email`, `Send DingTalk group message`, `Send DingTalk person message`, `Lock record` |
| Footer/test | `Test Run executes...`, `Save this automation before running a test.`, confirm message, status messages |

Typed discriminator requirements:

| Helper | Required type |
| --- | --- |
| `automationTriggerTypeLabel(type, isZh)` | `AutomationTriggerType` with raw fallback |
| `automationActionTypeLabel(type, isZh)` | `AutomationActionType` with raw fallback |
| `automationConditionOperatorLabel(op, isZh)` | `ConditionOperator` with raw fallback |
| `automationConditionValuePlaceholder(widget, isArray, isZh)` | explicit literal union, no free string |

### 5.4 T3D-3: Automation Manager

Real source: `MetaAutomationManager.vue`.

Representative target groups:

| Group | Examples |
| --- | --- |
| Shell | `Automations`, `Edit Automation`, `New Automation`, `+ New Automation`, `Quick legacy form` |
| Legacy quick form | `Name`, `Trigger`, `Action`, `Message`, `Target field`, `Value`, `Update`, `Create`, `Cancel` |
| Rule list | `Loading automations...`, `No automations yet. Create your first automation rule.`, `Enabled`, `Disabled`, `Edit`, `View Logs`, `View Deliveries`, `Delete` |
| Card summaries | `When a record is created`, `When "field" changes`, `Send notification`, `Update "field"`, `Public form: ...`, `Internal processing: ...`, `ok`, `fail` |
| Test run status | `Running test.`, `Running test. DingTalk actions may send real messages.`, `Test run succeeded`, `failed`, `skipped` |
| Composable fallbacks | `Failed to load/create/update/delete automation rule` from `useMultitableAutomations.ts` |

Manager cards must keep all rule names and field/view names raw. Description helpers should accept raw names and interpolate them without translation.

### 5.5 T3D-4: DingTalk Automation Chrome

Real source: shared code paths in `MetaAutomationManager.vue`, `MetaAutomationRuleEditor.vue`, and `dingtalk*.ts` helpers.

This is separated because manager and rule editor duplicate the same DingTalk group/person UI. The implementation should first extract/reuse shared automation label helpers, then wire both consumers.

Representative targets:

| Group | Examples |
| --- | --- |
| Presets | `Message preset`, `Form request`, `Internal processing`, `Form + processing` |
| Group config | `Add DingTalk groups`, `-- add DingTalk group --`, `Record group field paths (optional)`, `Pick group field` |
| Person config | `Search and add users or member groups`, `Local user IDs`, `Member group IDs (optional)`, `Pick recipient field`, `Pick member group field` |
| Template chrome | `Title template`, `Body template`, `Template tokens`, `Copy`, `Copied`, `Rendered title`, `No rendered title` |
| Link chrome | `Public form view (optional)`, `Internal processing view (optional)`, `Public form access`, `Allowed audience` |
| Warning helpers | unsupported placeholder, unknown placeholder, field path warnings, public/internal view link warnings |
| Existing zh-only placeholders | `例如：...`, `支持 ...`, `使用逗号...` must become bilingual through the label module. |

Scout-locked zh-only placeholders for T3D-4:

| File:line | Current zh-only text | Planned treatment |
| --- | --- | --- |
| `MetaAutomationManager.vue:169` | `例如：{{record.title}} 待处理` | bilingual title-template example placeholder |
| `MetaAutomationManager.vue:360` | `使用逗号或换行分隔本地 userId` | bilingual local-user-IDs placeholder |
| `MetaAutomationManager.vue:368` | `使用逗号或换行分隔成员组 ID` | bilingual member-group-IDs placeholder |
| `MetaAutomationManager.vue:376` | `例如：record.assigneeUserIds, record.reviewerUserId` | bilingual recipient-field-path placeholder |
| `MetaAutomationManager.vue:421` | `例如：record.watcherGroupIds, record.escalationGroupId` | bilingual member-group-field-path placeholder |
| `MetaAutomationManager.vue:466` | `例如：{{record.title}} 待处理` | bilingual person-title-template example placeholder |
| `MetaAutomationRuleEditor.vue:415` | `例如：{{record.title}} 待处理` | bilingual title-template example placeholder |
| `MetaAutomationRuleEditor.vue:627` | `使用逗号或换行分隔本地 userId` | bilingual local-user-IDs placeholder |
| `MetaAutomationRuleEditor.vue:635` | `使用逗号或换行分隔成员组 ID` | bilingual member-group-IDs placeholder |
| `MetaAutomationRuleEditor.vue:643` | `例如：record.assigneeUserIds, record.reviewerUserId` | bilingual recipient-field-path placeholder |
| `MetaAutomationRuleEditor.vue:688` | `例如：record.watcherGroupIds, record.escalationGroupId` | bilingual member-group-field-path placeholder |
| `MetaAutomationRuleEditor.vue:733` | `例如：{{record.title}} 待处理` | bilingual person-title-template example placeholder |

Template token labels should become locale-aware:

| Token | EN | zh |
| --- | --- | --- |
| `recordId` | Record ID | 记录 ID |
| `sheetId` | Sheet ID | 表 ID |
| `actorId` | Actor ID | 操作者 ID |
| `recordField` | Record field | 记录字段 |

## 6. A11y and Selector Boundary

T3D localizes existing text, placeholders, and `title` attributes where already present. It must not add new aria/title/placeholder attributes unless a separate accessibility bug is explicitly found and reviewed.

Known existing a11y-related attributes:

| File | Existing attributes |
| --- | --- |
| `MetaAutomationRuleEditor.vue` | `title="Remove group"`, `title="Remove condition"`, `title="Move up"`, `title="Move down"`, `title="Remove action"`, many placeholders |
| `MetaAutomationManager.vue` | placeholders in form inputs/textareas |
| `MetaAutomationLogViewer.vue` | no aria/title/placeholder additions required |
| Delivery viewers | no aria/title/placeholder additions required |

Each slice must lock the "no new a11y attributes" boundary with fixture-computed sentinel counts:

| Slice | Sentinel requirement |
| --- | --- |
| T3D-1 | Log viewer and delivery viewer specs assert `[aria-label]`, `[title]`, and `[placeholder]` counts for the mounted fixtures, even when the expected count is `0`. |
| T3D-2 | Rule editor spec asserts `[title]` count for the 5 existing title buttons and fixture-computed `[placeholder]` count. The test localizes existing text but must not create new attributes. |
| T3D-3 | Manager spec asserts fixture-computed `[placeholder]` count and `[aria-label]`/`[title]` counts. |
| T3D-4 | DingTalk wiring must not alter the counts already locked by T3D-2/T3D-3; verification records the before/after count for the touched fixtures. |

Selector boundary:

| Raw selector | Must remain raw |
| --- | --- |
| `data-action` | `refresh`, `retry`, `save`, `test`, `copy-support-packet`, etc. |
| `data-status` | `success`, `failed`, `skipped`, `running` |
| `data-field` / `data-automation-field` | field identifiers used by tests |
| class suffixes | `--success`, `--failed`, `--skipped`, `--running`, `--dingtalk_granted` |

## 7. Preflight Grep

Before each implementation slice, run a slice-specific grep and paste the output into the verification MD.

T3D-1 preflight:

```bash
rg -n "Execution Logs|Total|Success|Failed|Avg duration|All statuses|Skipped|Refresh|Failed to load logs|Retry|Loading logs|No execution logs|Copy redacted packet|Download JSON|Clipboard unavailable|Redacted packet copied|Copy failed|Redacted JSON downloaded|Download failed|DingTalk Group Deliveries|DingTalk Person Deliveries|Loading deliveries|No DingTalk group deliveries|No DingTalk person deliveries|Inactive user|DingTalk:|Failed to load DingTalk .* deliveries|DingTalk account is not linked" \
  apps/web/src/multitable/components/MetaAutomationLogViewer.vue \
  apps/web/src/multitable/components/MetaAutomationGroupDeliveryViewer.vue \
  apps/web/src/multitable/components/MetaAutomationPersonDeliveryViewer.vue
```

T3D-2/T3D-3/T3D-4 must use equivalent grep commands for their planned keys before writing labels. Any planned key without a real call-site must be removed or explicitly deferred before implementation.

No dead-key rule:

| Rule | Enforcement |
| --- | --- |
| Every new static key has a call-site | helper spec plus `rg "automationLabel\\('key'"` or equivalent in verification |
| Every helper has render or unit coverage | `meta-automation-labels.spec.ts` plus surface specs |
| Retired string keys are removed lockstep | union type, label map, and ALL_KEYS-style helper spec updated in same commit |

## 8. Test Plan

Shared test pattern:

| Requirement | Pattern |
| --- | --- |
| Locale reset | `useLocale().setLocale('en')` in `afterEach`, same as T3A/T3B/T3C/T3E specs |
| Mount/teardown | Canonical `createApp + container + app.unmount() + container.remove()` pattern |
| Raw/data checks | Assert `data-status`, `data-action`, `data-field`, and class suffixes remain raw |
| EN baseline | Existing English UI remains available when locale is `en` |
| zh render | Switch `useLocale().setLocale('zh-CN')`, assert visible Chinese chrome |
| Raw data | Assert rule names, field names, IDs, backend errors, and redacted text remain raw where expected |
| A11y sentinel counts | Assert fixture-computed `[aria-label]`, `[title]`, and `[placeholder]` counts; localizing existing text is allowed, adding attributes is not. |

T3D-1 tests:

| Spec | Coverage |
| --- | --- |
| `meta-automation-labels.spec.ts` | all initial keys, status helpers, action helper fallback, support status helpers |
| `MetaAutomationLogViewer.spec.ts` | zh title/stats/status/filter/buttons; raw `data-status`; raw `triggeredBy`; redacted step content unchanged; support packet status localized |
| `meta-automation-delivery-viewers-i18n.spec.ts` | group/person zh titles, filters, status labels, empty/loading states, `DingTalk:` prefix, raw IDs and `data-status`; `[aria-label]`/`[title]`/`[placeholder]` counts locked |

T3D-2 tests:

| Spec | Coverage |
| --- | --- |
| `meta-automation-labels.spec.ts` | trigger/action/operator helpers and raw fallback |
| `multitable-automation-rule-editor.spec.ts` | zh render sentinel for trigger/action/condition sections; raw option values; `data-action`, `data-field`, `data-status` unchanged; test-run confirm localized; `[title]` and `[placeholder]` counts locked |

T3D-3 tests:

| Spec | Coverage |
| --- | --- |
| `multitable-automation-manager.spec.ts` | zh manager shell/card actions; enabled/disabled labels; card summary helpers; composable fallback labels; raw rule/field/view names; `[aria-label]`/`[title]`/`[placeholder]` counts locked |

T3D-4 tests:

| Spec | Coverage |
| --- | --- |
| `meta-automation-labels.spec.ts` | DingTalk helper labels, token labels, warning helper labels |
| `multitable-automation-rule-editor.spec.ts` | DingTalk group/person action chrome in zh; warning strings localized; template raw values unchanged |
| `multitable-automation-manager.spec.ts` | legacy quick-form DingTalk chrome in zh; preview labels localized; copied/copy states localized |
| existing DingTalk warning specs | update to accept locale-aware helpers while preserving raw field/view names |

Validation commands, package-relative because `--filter @metasheet/web exec` runs with `apps/web` as cwd:

```bash
pnpm --filter @metasheet/web exec vitest run tests/meta-automation-labels.spec.ts tests/MetaAutomationLogViewer.spec.ts tests/meta-automation-delivery-viewers-i18n.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

For T3D-2/T3D-3/T3D-4, add the relevant existing specs:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --reporter=dot
```

## 9. Implementation Order

T3D-1:

1. Run the T3D-1 preflight grep in section 7.
2. Add `meta-automation-labels.ts` with status/action/log/delivery keys and helpers.
3. Add `meta-automation-labels.spec.ts`.
4. Wire `MetaAutomationLogViewer.vue`.
5. Wire group/person delivery viewers.
6. Extend existing log viewer spec and add delivery viewer i18n spec.
7. Write verification MD with grep evidence, helper reachability evidence, and test output.
8. Run targeted tests, `vue-tsc`, build, and `git diff --check`.
9. Commit, stop before push.

T3D-2:

1. Extend `meta-automation-labels.ts` with trigger/action/operator/editor core keys.
2. Refactor `conditionOperators` labels so values remain raw while labels call helper.
3. Wire rule editor shell, trigger, schedule, conditions, and non-DingTalk action panels.
4. Localize test-run confirm and footer copy.
5. Extend rule editor tests.
6. Commit, stop before push.

T3D-3:

1. Extend module with manager shell/card/legacy-form keys.
2. Wire manager visible chrome and description helpers.
3. Wire `useMultitableAutomations.ts` static fallbacks only; backend errors remain raw when present.
4. Extend manager tests.
5. Commit, stop before push.

T3D-4:

1. Extend module with DingTalk-specific labels and helper functions.
2. Make template token labels locale-aware without changing token values.
3. Make warning helpers locale-aware; raw field/view/template values stay interpolated raw.
4. Wire DingTalk group/person config branches in both manager and rule editor.
5. Extend DingTalk warning/token tests and the manager/rule-editor specs.
6. Commit, stop before push.

## 10. Risk Register

| Risk | Mitigation |
| --- | --- |
| Display text leaks into `data-*` or CSS selectors | Keep helper calls only in visible text/placeholder/title positions; spec asserts raw `data-status` and option values. |
| Persisted enum values accidentally localized | Select `value` attributes remain literal raw enums; helper only controls option text. |
| Unknown future enum values disappear | Helper functions must return `String(value)` for unknown values. |
| Redaction/support-packet semantics change | Do not alter redaction utility behavior; tests keep sentinel leak checks. |
| Existing tests assert English strings | Update only tests for localized chrome; raw behavior assertions must remain. |
| Warning helpers translate user data | Helper functions interpolate raw names/IDs without translating them. |
| T3D single PR becomes unreviewable | Four-slice plan; T3D-1 proves module/test shape before large editor/manager changes. |
| Existing zh-only placeholders remain asymmetric | T3D-4 converts them to bilingual helpers instead of leaving zh-only literals. |
| Four back-to-back PRs share `meta-automation-labels.ts`, so mid-flight rebase can conflict in the union type or label map | Before pushing T3D-2/T3D-3/T3D-4, run `git fetch origin && git rebase origin/main`; if the PR is already pushed and becomes BEHIND, use `git push --force-with-lease`; after rebase, inspect `git diff --name-status origin/main..HEAD` to confirm the slice scope is unchanged. |

## 11. Approval Gate

T3D-1 can start implementation when reviewers accept:

1. One automation-domain label module instead of per-component modules.
2. Four PR split: log/delivery first, rule editor second, manager third, DingTalk helpers fourth.
3. Visible enum labels localized while option values, `data-*`, class suffixes, and persisted config remain raw.
4. Backend/runtime/redacted error content remains raw except static frontend fallback labels.
5. T3D-1 test surface: helper spec + log viewer spec + delivery viewer spec.

T3D-2/T3D-3/T3D-4 each require a short implementation note in their verification MD that maps planned keys to real call-sites and confirms no dead keys were introduced.

T3D-2/T3D-3/T3D-4 verification MDs must also include reuse-grep evidence for helpers consumed from earlier T3D slices, for example proving `automationStatusLabel`, `automationActionTypeLabel`, or `automationConditionOperatorLabel` still exists in `meta-automation-labels.ts` before the later slice extends it.
