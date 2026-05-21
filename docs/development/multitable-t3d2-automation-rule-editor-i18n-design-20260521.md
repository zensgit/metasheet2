# Multitable T3D-2 Automation Rule Editor I18n Design - 2026-05-21

## 1. Decision Summary

T3D-2 is the second PR in the T3D automation i18n chain. T3D-1 has already landed `meta-automation-labels.ts` and localized the log/delivery viewers. T3D-2 extends that same automation-domain module and wires only the core `MetaAutomationRuleEditor.vue` chrome.

Scope choice:
- In scope: rule editor shell, trigger selector/config, schedule config, condition builder, non-DingTalk action config, action selector labels, save/test/cancel footer, test-run warning/confirm copy, and save fallback.
- Out of scope: DingTalk group/person action configuration panels and shared DingTalk helper utilities. Those remain T3D-4 because they span manager + rule editor and include token helpers, recipient warnings, link summaries, and zh-only placeholder cleanup.

This keeps the 2,748-line rule editor reviewable and avoids mixing the core enum-heavy editor with DingTalk-specific copy.

## 2. Scout Facts

Files:

| File | Lines | Notes |
| --- | ---: | --- |
| `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` | 2,748 | Core editor + large DingTalk subpanels in one component. |
| `apps/web/tests/multitable-automation-rule-editor.spec.ts` | 3,154 | Existing behavior-heavy spec; reuse this instead of creating a new mount harness. |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | 157 | T3D-1 module to extend. |

Current a11y attribute counts in `MetaAutomationRuleEditor.vue` source:

| Attribute | Source count | T3D-2 policy |
| --- | ---: | --- |
| `aria-label` | 0 | Do not add. |
| `title=` | 5 | Localize existing title text only. Count remains unchanged. |
| `placeholder=` | 25 | Localize in-scope core placeholders only. Count remains unchanged. |

Typed source unions:

| Type | Source |
| --- | --- |
| `AutomationTriggerType` | `types.ts`: `record.created`, `record.updated`, `record.deleted`, `field.value_changed`, `schedule.cron`, `schedule.interval`, `webhook.received`, legacy `field.changed`. |
| `AutomationActionType` | `types.ts`: `update_record`, `create_record`, `send_webhook`, `send_notification`, `send_email`, `send_dingtalk_group_message`, `send_dingtalk_person_message`, `lock_record`, legacy `notify`, `update_field`. |
| `ConditionOperator` | `types.ts`: `equals`, `not_equals`, `contains`, `not_contains`, `greater_than`, `less_than`, `greater_or_equal`, `less_or_equal`, `is_empty`, `is_not_empty`, `in`, `not_in`. |
| `ConditionValueWidget` | `MetaAutomationRuleEditor.vue`: `text`, `number`, `date`, `dateTime`, `boolean`, `booleanMultiSelect`, `select`, `multiSelect`. |

## 3. Files In Scope

| File | Change |
| --- | --- |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | Extend T3D-1 module with editor/trigger/schedule/condition/action-config/test-run labels and helpers. |
| `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` | Wire core editor chrome to `useLocale()` + automation helpers. |
| `apps/web/tests/meta-automation-labels.spec.ts` | Add helper/key coverage for T3D-2. |
| `apps/web/tests/multitable-automation-rule-editor.spec.ts` | Add zh/en render assertions, raw-boundary assertions, a11y sentinel counts. |
| `docs/development/multitable-t3d2-automation-rule-editor-i18n-verification-20260521.md` | Verification report after implementation. |

Out of scope:

| Area | Why |
| --- | --- |
| DingTalk group/person action panels, lines ~319-869 | T3D-4 owns shared DingTalk copy, token labels, recipient warnings, link summaries, and zh-only placeholder cleanup. |
| `MetaAutomationManager.vue` | T3D-3. |
| `dingtalk*.ts` helper utilities | T3D-4. |
| Backend/contracts/migrations/attendance/K3 | T3D remains frontend i18n only. |

## 4. Label Module Extension

Extend the existing `apps/web/src/multitable/utils/meta-automation-labels.ts`.

New or extended static key groups:

| Namespace | Examples |
| --- | --- |
| `editor.*` | title create/edit, name, automation-name placeholder, save/saving/cancel, add field/action, select field/value. |
| `trigger.*` | trigger section labels, trigger type labels, watch-field config, schedule labels. |
| `condition.*` | conditions title, optional, group, add condition/group, remove titles, boolean/value placeholders. |
| `actionConfig.*` | non-DingTalk action config labels/placeholders/hints for update/create/webhook/notification/email. |
| `testRun.*` | test run button/running labels, unsaved hint, DingTalk warning, confirm text. |
| `error.*` | save fallback only. Backend `Error.message` still wins. |
| `status.running` | Convert T3D-1 inline `running` handling into a real label key. |

Helper additions:

```ts
export type AutomationConditionValueWidget =
  | 'text'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'boolean'
  | 'booleanMultiSelect'
  | 'select'
  | 'multiSelect'

export type AutomationTriggerCondition = 'any' | 'equals' | 'changed_to'
export type AutomationCronPresetValue =
  | '*/5 * * * *'
  | '0 * * * *'
  | '0 0 * * *'
  | '0 0 * * 1'
  | 'custom'

export function automationTriggerTypeLabel(type: AutomationTriggerType | (string & {}), isZh: boolean): string
export function automationTriggerConditionLabel(condition: AutomationTriggerCondition | (string & {}), isZh: boolean): string
export function automationCronPresetLabel(value: AutomationCronPresetValue | (string & {}), isZh: boolean): string
export function automationConditionOperatorLabel(operator: ConditionOperator | (string & {}), isZh: boolean): string
export function automationConditionValuePlaceholder(widget: AutomationConditionValueWidget, isArray: boolean, isZh: boolean): string
```

Rules:
- All discriminator helpers must use explicit literal unions or imported project types. Do not accept plain `string` unless paired with `(string & {})` for unknown fallback.
- Unknown trigger/action/operator/preset values return `String(value)` raw.
- `automationActionTypeLabel(...)` already exists from T3D-1 and should be reused for action select labels.
- `automationStatusLabel('running', ...)` should read `status.running` instead of inline text to keep the key map complete.

## 5. Exact Chrome Targets

### 5.1 Shell

| Source | zh | Key/helper |
| --- | --- | --- |
| `Edit Automation Rule` | 编辑自动化规则 | `editor.titleEdit` |
| `New Automation Rule` | 新建自动化规则 | `editor.titleNew` |
| `Name` | 名称 | `editor.name` |
| `Automation name` | 自动化名称 | `editor.namePlaceholder` |
| `Save` / `Saving...` | 保存 / 正在保存... | `editor.save` / `editor.saving` |
| `Cancel` | 取消 | `editor.cancel` |
| `Save failed` | 保存失败 | `error.saveFailed` fallback only; raw `e.message` still wins. |

### 5.2 Trigger + Schedule

| Source | zh | Key/helper |
| --- | --- | --- |
| `Trigger` | 触发器 | `trigger.title` |
| `When record created` | 当记录创建时 | `automationTriggerTypeLabel('record.created')` |
| `When record updated` | 当记录更新时 | `automationTriggerTypeLabel('record.updated')` |
| `When record deleted` | 当记录删除时 | `automationTriggerTypeLabel('record.deleted')` |
| `When field value changed` | 当字段值变化时 | `automationTriggerTypeLabel('field.value_changed')` |
| `Schedule (cron)` | 定时计划（cron） | `automationTriggerTypeLabel('schedule.cron')` |
| `Schedule (interval)` | 定时计划（间隔） | `automationTriggerTypeLabel('schedule.interval')` |
| `Webhook received` | 收到 Webhook 时 | `automationTriggerTypeLabel('webhook.received')` |
| legacy `field.changed` | 当字段变化时 | `automationTriggerTypeLabel('field.changed')` |
| `Watch field` | 监听字段 | `trigger.watchField` |
| `-- select field --` | -- 选择字段 -- | `trigger.selectField` |
| `Condition` | 条件 | `trigger.condition` |
| `Any change` / `Equals` / `Changed to` | 任意变化 / 等于 / 变更为 | `automationTriggerConditionLabel(...)` |
| `Value` | 值 | `editor.value` |
| `Preset` | 预设 | `trigger.preset` |
| `Every 5 minutes` | 每 5 分钟 | `automationCronPresetLabel('*/5 * * * *')` |
| `Every hour` | 每小时 | `automationCronPresetLabel('0 * * * *')` |
| `Daily at midnight` | 每天午夜 | `automationCronPresetLabel('0 0 * * *')` |
| `Weekly (Monday)` | 每周一 | `automationCronPresetLabel('0 0 * * 1')` |
| `Custom` | 自定义 | `automationCronPresetLabel('custom')` |
| `Cron expression` | Cron 表达式 | `trigger.cronExpression` |
| `Interval (minutes)` | 间隔（分钟） | `trigger.intervalMinutes` |

Raw:
- option `value` attributes (`record.created`, cron strings, `custom`) remain raw.
- field names remain raw.
- cron placeholder `* * * * *` and numeric placeholder `5` remain raw syntax examples.

### 5.3 Condition Builder

| Source | zh | Key/helper |
| --- | --- | --- |
| `Conditions` | 条件 | `condition.title` |
| `(optional)` | （可选） | `condition.optional` |
| `AND` / `OR` | 且 / 或 | `condition.and` / `condition.or` visible text only; raw model values stay uppercase. |
| `Group` | 条件组 | `condition.group` |
| `+ Condition` | + 条件 | `condition.addNestedCondition` |
| `+ Group` | + 条件组 | `condition.addNestedGroup` |
| `Remove group` | 移除条件组 | `condition.removeGroupTitle` |
| `-- field --` | -- 字段 -- | `condition.selectField` |
| `-- value --` | -- 值 -- | `condition.selectValue` |
| `+ Add condition` | + 添加条件 | `condition.addCondition` |
| `+ Add group` | + 添加条件组 | `condition.addGroup` |
| `Remove condition` | 移除条件 | `condition.removeConditionTitle` |

Operator labels:

| Operator | zh |
| --- | --- |
| `equals` | 等于 |
| `not_equals` | 不等于 |
| `contains` | 包含 |
| `not_contains` | 不包含 |
| `greater_than` | 大于 |
| `less_than` | 小于 |
| `greater_or_equal` | 大于等于 |
| `less_or_equal` | 小于等于 |
| `is_empty` | 为空 |
| `is_not_empty` | 不为空 |
| `in` | 在列表中 |
| `not_in` | 不在列表中 |

Condition value placeholders:

| Existing output | zh | Rule |
| --- | --- | --- |
| `Comma-separated values` | 逗号分隔的值 | `isArray=true`, regardless of widget. |
| `Number` | 数字 | widget `number`. |
| `YYYY-MM-DD` | `YYYY-MM-DD` | date syntax stays raw. |
| `Date and time` | 日期和时间 | widget `dateTime`. |
| `Value` | 值 | default. |

Implementation note:
- Refactor `ConditionOperatorOption` to keep raw `value` as the semantic source. Do not store localized labels in a static module-level array.
- Template should render `automationConditionOperatorLabel(op.value, isZh)`.
- `optionLabel(option)` for select/multi-select field options remains raw user/admin data.

### 5.4 Action Selector + Non-DingTalk Action Config

Action select labels use the existing `automationActionTypeLabel(...)`:

| Action type | zh |
| --- | --- |
| `update_record` | 更新记录 |
| `create_record` | 创建记录 |
| `send_webhook` | 发送 Webhook |
| `send_notification` / legacy `notify` | 发送通知 |
| `send_email` | 发送邮件 |
| `send_dingtalk_group_message` | 发送钉钉群消息 |
| `send_dingtalk_person_message` | 发送钉钉个人消息 |
| `lock_record` | 锁定记录 |
| legacy `update_field` | 更新字段值 |

Non-DingTalk config targets:

| Source | zh | Notes |
| --- | --- | --- |
| `Actions` | 动作 | `editor.actions` |
| `(1-3 steps)` | （1-3 步） | `editor.actionStepHint` |
| `Move up` / `Move down` / `Remove action` | 上移 / 下移 / 移除动作 | title attrs only; count unchanged. |
| `+ Field` | + 字段 | used in update/create record config. |
| `Target sheet ID` | 目标工作表 ID | label. |
| `Sheet ID` | 工作表 ID | placeholder. |
| `Field ID` | 字段 ID | placeholder. |
| `URL` / `Method` | URL / 方法 | URL stays unchanged. |
| `User ID` / `Message` | 用户 ID / 消息 | notification config. |
| `Notification message` | 通知内容 | placeholder. |
| `Recipients` | 收件人 | email config. |
| `Use comma or newline separated email addresses. Delivery uses the NotificationService email channel.` | 使用逗号或换行分隔邮箱地址。投递使用 NotificationService 邮件通道。 | hint. |
| `Subject template` | 主题模板 | email config. |
| `{{record.title}} needs attention` | `{{record.title}} 需要处理` | template placeholder; tokens remain raw. |
| `Body template` | 正文模板 | email config. |
| `Record {{recordId}} changed. Status: {{record.status}}` | `记录 {{recordId}} 已变更。状态：{{record.status}}` | template placeholder; tokens remain raw. |
| `+ Add action` | + 添加动作 | footer of action list. |

Raw:
- `data-action`, `data-action-index`, and action `value` attributes remain raw.
- HTTP methods `POST`/`PUT`/`GET` remain raw visible protocol values.
- URL placeholder `https://...` remains raw.
- email examples `ops@example.com, owner@example.com` remain raw.

Deferred to T3D-4:
- Everything inside `send_dingtalk_group_message` and `send_dingtalk_person_message` config panels except the action select visible labels.
- Existing zh-only placeholders at lines 415/627/635/643/688/733 and related DingTalk helper copy.

### 5.5 Footer + Test Run

| Source | zh | Notes |
| --- | --- | --- |
| `Test Run executes the saved rule and can send real DingTalk messages to configured groups or users.` | 测试运行会执行已保存规则，并可能向已配置的钉钉群或用户发送真实消息。 | visible warning. |
| Confirm string with `Unsaved changes are not included. Continue?` | 测试运行会执行已保存规则，并可能向已配置的钉钉群或用户发送真实消息。未保存的更改不会包含在内。是否继续？ | `window.confirm(...)` text. |
| `Save this automation before running a test.` | 请先保存此自动化，再运行测试。 | unsaved hint. |
| `Running...` / `Test Run` | 正在运行... / 测试运行 | button text. |
| `props.testRunState.message` | raw | Runtime/parent-provided message remains raw for T3D-2. |

## 6. Raw Boundary

Preserve raw:
- `data-field`, `data-action`, `data-condition-*`, `data-status`, `data-access-level`, CSS suffixes.
- `<option value="...">` values for triggers, cron presets, trigger conditions, condition operators, booleans, action types, HTTP methods.
- Field names, option labels, view names, DingTalk group/user names, rule names.
- Record/template tokens such as `{{recordId}}`, `{{record.status}}`, `record.<fieldId>`.
- Backend/runtime error text. Only static fallback `Save failed` is localized.
- `props.testRunState.message`.

Visible labels may be localized through helpers. Unknown enum values must render raw with `String(value)`.

M1 trap guard:

```vue
<option :value="triggerType">
  {{ automationTriggerTypeLabel(triggerType, isZh) }}
</option>
```

Do not bind localized text to `value`, `data-*`, class suffixes, or model data.

## 7. A11y Boundary

T3D-2 localizes existing title/placeholder text. It must not add new a11y attributes.

Required sentinel assertions in `multitable-automation-rule-editor.spec.ts`:
- Fixture count for `[aria-label]` remains the same as before implementation.
- Fixture count for `[title]` remains the same as before implementation.
- Fixture count for `[placeholder]` remains the same as before implementation.

Source-level scout found:
- `aria-label`: 0
- `title=`: 5
- `placeholder=`: 25

Implementation tests should measure the rendered fixture count after the wiring and assert the expected fixture-computed values. The source counts above are not a replacement for render-level sentinel assertions.

## 8. Test Plan

### 8.1 Label Helper Spec

Extend `apps/web/tests/meta-automation-labels.spec.ts`:
- `AUTOMATION_LABEL_KEYS` stays unique and readable in both locales.
- `automationTriggerTypeLabel(...)` covers all current trigger types + legacy `field.changed` + unknown fallback.
- `automationActionTypeLabel(...)` existing coverage remains; add any missing action aliases if needed.
- `automationConditionOperatorLabel(...)` covers all 12 operators + unknown fallback.
- `automationConditionValuePlaceholder(...)` covers `text`, `number`, `date`, `dateTime`, `boolean`, `booleanMultiSelect`, `select`, `multiSelect` and array/non-array paths.
- `automationTriggerConditionLabel(...)` covers `any`, `equals`, `changed_to`, unknown fallback.
- `automationCronPresetLabel(...)` covers the 5 current preset values + unknown fallback.
- `automationStatusLabel('running', true)` reads through the key-backed `status.running` path.

### 8.2 Rule Editor Render Spec

Extend `apps/web/tests/multitable-automation-rule-editor.spec.ts` using the existing mount helper.

Add focused zh-CN tests:
- Shell + trigger section: titles, trigger option visible labels, field trigger config, cron preset labels; raw option values unchanged.
- Condition builder: zh condition controls, operator visible labels, raw `ConditionOperator` values, field/option labels remain raw.
- Placeholder helper: numeric array -> `逗号分隔的值`, number -> `数字`, date -> `YYYY-MM-DD`, dateTime -> `日期和时间`, default -> `值`.
- Non-DingTalk action config: update/create/webhook/notification/email labels and placeholders; action values and HTTP methods raw.
- Footer/test-run: unsaved hint, running/test-run button labels, DingTalk warning and confirm text.
- A11y sentinel: `[aria-label]`, `[title]`, `[placeholder]` fixture counts locked.

Existing behavior tests must remain intact. If existing tests assert English text directly, update them to assert locale-specific text only where the test is about i18n; behavior tests should keep selecting by raw `data-*` selectors.

### 8.3 Validation Commands

Package-relative paths because `pnpm --filter @metasheet/web exec` runs from `apps/web`:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-automation-labels.spec.ts \
  tests/multitable-automation-rule-editor.spec.ts \
  --reporter=dot

pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
git diff --check
```

## 9. Preflight Grep

Before implementation, run:

```bash
rg -n "Edit Automation Rule|New Automation Rule|Automation name|When record created|When record updated|When record deleted|When field value changed|Schedule \\(cron\\)|Schedule \\(interval\\)|Webhook received|-- select field --|Any change|Changed to|Every 5 minutes|Every hour|Daily at midnight|Weekly \\(Monday\\)|Conditions|\\+ Condition|\\+ Add condition|Actions|Update record|Create record|Send webhook|Send notification|Send email|Lock record|Target sheet ID|Notification message|Use comma or newline separated email addresses|Save this automation before running a test|Saving\\.\\.\\.|Test Run|Save failed" apps/web/src/multitable/components/MetaAutomationRuleEditor.vue
```

Expected:
- Hits only in `MetaAutomationRuleEditor.vue`.
- DingTalk panel hits may appear for action option labels and test-run warning only. Do not wire deeper DingTalk panel strings in T3D-2.

Also run helper reachability after wiring:

```bash
rg -n "automationTriggerTypeLabel\\(|automationConditionOperatorLabel\\(|automationConditionValuePlaceholder\\(|automationTriggerConditionLabel\\(|automationCronPresetLabel\\(|automationActionTypeLabel\\(" apps/web/src/multitable apps/web/tests
```

## 10. Implementation Order

1. Run §9 preflight grep and record hit summary for verification MD.
2. Extend `meta-automation-labels.ts` with T3D-2 keys/types/helpers.
3. Refactor condition operator options so raw `value` is stored and visible text is rendered via `automationConditionOperatorLabel(...)`.
4. Wire `MetaAutomationRuleEditor.vue` core shell, trigger/schedule, condition builder, non-DingTalk action config, and footer.
5. Leave DingTalk group/person config panels unchanged except action select visible labels and test-run warning/confirm text.
6. Extend `meta-automation-labels.spec.ts`.
7. Extend `multitable-automation-rule-editor.spec.ts` with zh-CN render tests, raw-boundary tests, and a11y sentinel counts.
8. Create `docs/development/multitable-t3d2-automation-rule-editor-i18n-verification-20260521.md`.
9. Run §8.3 validation commands.
10. Commit locally and stop before push.

## 11. Risk Register

| Risk | Mitigation |
| --- | --- |
| Static `conditionOperators` labels become stale on locale toggle. | Store raw `value` only and render via helper in template. |
| Localized labels accidentally become option `value` or `data-*`. | Tests assert raw values and selectors. |
| DingTalk panel scope creep. | T3D-2 touches only action select labels and test-run warning/confirm. Deep DingTalk panel strings remain T3D-4. |
| Existing behavior-heavy RuleEditor spec becomes noisy. | Reuse existing mount helper; add focused i18n tests rather than rewriting baseline tests. |
| `props.testRunState.message` appears English. | Leave raw in T3D-2; parent/runtime message ownership is outside this slice. |
| 4-PR chain rebase risk on `meta-automation-labels.ts`. | Before push: `git fetch origin && git rebase origin/main`; if PR becomes BEHIND use `git push --force-with-lease`. After rebase, re-run targeted tests and `git diff --name-status origin/main..HEAD` to confirm only T3D-2 files changed. |

## 12. Approval Gate

T3D-2 implementation is ready only if:
- `meta-automation-labels.ts` remains the single automation-domain label module.
- Helper discriminator types are explicit; no free-string widget/operator/action helpers.
- Raw values stay raw for selectors/config/data attributes.
- DingTalk deep panel strings are not wired in this PR.
- A11y sentinel counts are documented and asserted.
- Targeted rule-editor/helper tests, `vue-tsc`, build, and diff-check pass.
