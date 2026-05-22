# T3D-3 Automation Manager i18n Design

Date: 2026-05-21

Branch: `docs/multitable-t3d3-automation-manager-i18n-design-20260521`

Base: `origin/main@71e8eef1b`

## 1. Decision Summary

T3D-3 is the third PR in the 4-PR T3D automation i18n chain.

| Decision | Outcome |
| --- | --- |
| Module | Continue extending `apps/web/src/multitable/utils/meta-automation-labels.ts`; no new module. |
| Primary component | `apps/web/src/multitable/components/MetaAutomationManager.vue` only. |
| Composable | `apps/web/src/multitable/composables/useMultitableAutomations.ts` static frontend fallback errors are in scope. |
| Scope | Manager shell, rule cards, card-level DingTalk summaries/links, legacy quick form core chrome, test-run card messages, and manager-owned fallback errors. |
| Defer | Deep DingTalk configuration panels, token/preset/warning helpers, preview labels, shared DingTalk link access-summary helpers, and zh-only placeholders stay T3D-4. |
| Tests | Extend `meta-automation-labels.spec.ts` and `multitable-automation-manager.spec.ts`; do not create a new manager harness. |

This preserves the parent T3D split:

- T3D-1: log + delivery viewers shipped.
- T3D-2: rule editor core shipped.
- T3D-3: manager shell/cards/quick form.
- T3D-4: DingTalk automation shared chrome across manager + rule editor.

## 2. Scout Snapshot

Real source:

| File | Lines | Role |
| --- | ---: | --- |
| `MetaAutomationManager.vue` | 2,283 | Manager dialog, legacy quick form, rule cards, DingTalk card links, test-run card status. |
| `useMultitableAutomations.ts` | 67 | Manager-only CRUD composable with static frontend fallbacks. |
| `multitable-automation-manager.spec.ts` | 2,841 | Existing heavy manager behavior spec; extend this rather than add a new mount harness. |
| `meta-automation-labels.ts` | 445 | T3D shared label module after T3D-1/T3D-2. |

Source attribute counts in `MetaAutomationManager.vue`:

| Attribute | Source count | T3D-3 rule |
| --- | ---: | --- |
| `aria-label=` | 0 | Spec sentinel must keep fixture count at 0. |
| `title=` | 0 | Spec sentinel must keep fixture count at 0. |
| `placeholder=` | 13 | T3D-3 localizes only in-scope quick-form placeholders; T3D-4 owns DingTalk placeholder cleanup. |
| `data-*` / `:data-*` | 96 | Values are raw selectors and must not bind localized display text. |
| `:class` | 4 | Raw enum/state suffixes stay raw. |

## 3. Files In Scope

Implementation files:

| File | Change |
| --- | --- |
| `apps/web/src/multitable/utils/meta-automation-labels.ts` | Add manager keys and helpers; reuse T3D-1/T3D-2 helpers. |
| `apps/web/src/multitable/components/MetaAutomationManager.vue` | Wire manager shell/card/quick-form/test-run chrome. |
| `apps/web/src/multitable/composables/useMultitableAutomations.ts` | Localize static frontend fallback errors; keep backend `e.message` raw. |

Test files:

| File | Change |
| --- | --- |
| `apps/web/tests/meta-automation-labels.spec.ts` | Add manager helper coverage, ALL_KEYS lockstep, raw fallback checks. |
| `apps/web/tests/multitable-automation-manager.spec.ts` | Add zh/en manager render assertions, raw selector checks, a11y sentinels. |

Docs:

| File | Change |
| --- | --- |
| `docs/development/multitable-t3d3-automation-manager-i18n-design-20260521.md` | This design. |
| `docs/development/multitable-t3d3-automation-manager-i18n-verification-20260521.md` | Implementation evidence. |

Out of scope:

| Surface | Reason |
| --- | --- |
| `MetaAutomationRuleEditor.vue` | T3D-2 core shipped; DingTalk panels remain T3D-4. |
| `dingtalk*.ts` helper utilities | T3D-4 owns shared token/warning/access copy. |
| Deep DingTalk config branches inside `MetaAutomationManager.vue` | T3D-4 spans manager + rule editor and will handle shared DingTalk copy consistently. |
| Existing zh-only DingTalk placeholders | T3D-4 converts them to bilingual helpers. |
| Backend, contracts, migrations, attendance, K3 | K3 PoC stage-1 lock; this is frontend i18n only. |

## 4. Exact Chrome Targets

### 4.1 Manager Shell And Legacy Quick Form Core

These are in scope and should be wired through `automationLabel(...)` or existing T3D-2 helpers.

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| L5 | `Automations` | `自动化` | `manager.title` |
| L14 | `Edit Automation` | `编辑自动化` | `manager.quickEditTitle` |
| L14 | `New Automation` | `新建自动化` | `manager.quickNewTitle` |
| L16 | `Name` | `名称` | reuse `editor.name` |
| L21 | `Automation name` | `自动化名称` | reuse `editor.namePlaceholder` |
| L25 | `Trigger` | `触发器` | reuse `trigger.title` |
| L27-L29 | trigger options | existing zh trigger labels | reuse `automationTriggerTypeLabel(...)` |
| L33 | `Watch field` | `监听字段` | reuse `trigger.watchField` |
| L35/L62 | `-- select field --` | `-- 选择字段 --` | reuse `trigger.selectField` |
| L40 | `Action` | `动作` | `manager.action` |
| L42-L45 | action options | existing zh action labels | reuse `automationActionTypeLabel(...)` |
| L49 | `Message` | `消息` | reuse `actionConfig.message` |
| L54 | `Notification message` | `通知内容` | reuse `actionConfig.notificationMessagePlaceholder` |
| L60 | `Target field` | `目标字段` | `manager.targetField` |
| L65 | `Value` | `值` | reuse `editor.value` |
| L70 | `New value` | `新值` | `manager.newValuePlaceholder` |
| L587-L590 | `Update` / `Create` / `Cancel` | `更新` / `创建` / `取消` | `manager.update`, `manager.create`, reuse `editor.cancel` |
| L602 | `+ New Automation` | `+ 新建自动化` | `manager.newAutomation` |
| L610 | `Quick legacy form` | `快速旧版表单` | `manager.quickLegacyForm` |
| L615 | `Loading automations...` | `正在加载自动化...` | `manager.loading` |
| L617 | `No automations yet. Create your first automation rule.` | `暂无自动化。创建第一条自动化规则。` | `manager.empty` |

Deep DingTalk quick-form blocks under the same legacy form are not fully localized here. T3D-3 may localize shared action select labels because `automationActionTypeLabel(...)` already owns them, but labels such as `Message preset`, `Template tokens`, `Public form view`, preview labels, token buttons, warnings, and DingTalk-specific placeholders remain T3D-4.

### 4.2 Rule Cards And Card Actions

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| L634 | `Enabled` / `Disabled` | `已启用` / `已停用` | `manager.enabled`, `manager.disabled` |
| L638 | `describeTrigger(rule) -> describeAction(rule)` | localized card summary | new dynamic helpers below |
| L679 | `Allowed audience:` | `允许范围：` | `manager.allowedAudiencePrefix` |
| L684-L685 | `${n} ok` / `${n} fail` | `${n} 成功` / `${n} 失败` | `automationCardStats(count, status, isZh)` or `manager.statOk/Fail` |
| L697 | `Edit` | `编辑` | `manager.edit` |
| L698 | `View Logs` | `查看日志` | `manager.viewLogs` |
| L706/L715 | `View Deliveries` | `查看投递记录` | `manager.viewDeliveries` |
| L717 | `Delete` | `删除` | `manager.delete` |

Card-level DingTalk display is in scope:

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| L1239 | `Open public form: ${view}` | `打开公开表单：${view}` | `automationCardLinkLabel('publicForm', viewName, isZh)` |
| L1257 | `Open internal view: ${view}` | `打开内部处理视图：${view}` | `automationCardLinkLabel('internalView', viewName, isZh)` |
| L1864 | `Public form: ${view}` | `公开表单：${view}` | `automationCardLinkSummary('publicForm', viewName, isZh)` |
| L1865 | `Internal processing: ${view}` | `内部处理：${view}` | `automationCardLinkSummary('internalView', viewName, isZh)` |
| L679 | `Allowed audience: ${summary}` | `允许范围：${summary}` | prefix only; `summary` stays as returned by helper until T3D-4 |

Card-level vs panel-level DingTalk boundary:

- In scope: manager card labels and summaries owned directly by `MetaAutomationManager.vue`, such as `Public form:`, `Open public form:`, `Internal processing:`, `Allowed audience:`, `ok`, and `fail`.
- Deferred: access-summary text returned by shared DingTalk helpers, warning copy, template token labels, preview labels, and the deep config panel copy. Those require shared helper changes across manager + rule editor and belong to T3D-4.
- Link label vs summary helpers are intentionally separate: label helpers include the `Open` / `打开` action prefix for clickable controls; summary helpers use bare `X:` / `X：` text inside card descriptions.

### 4.3 Dynamic Card Summary Helpers

Add these helpers to `meta-automation-labels.ts`:

```ts
export function automationCardTriggerSummary(
  triggerType: AutomationTriggerType | (string & {}),
  fieldName: string,
  isZh: boolean,
): string

export function automationCardActionSummary(
  actionType: AutomationActionType | (string & {}),
  fieldName: string,
  isZh: boolean,
): string
```

Additional card and test-run helper signatures:

```ts
export type AutomationCardLinkVariant = 'publicForm' | 'internalView'
export type AutomationCardStatType = 'ok' | 'fail'

export function automationCardLinkLabel(
  variant: AutomationCardLinkVariant,
  viewName: string,
  isZh: boolean,
): string

export function automationCardLinkSummary(
  variant: AutomationCardLinkVariant,
  viewName: string,
  isZh: boolean,
): string

export function automationCardStats(
  count: number,
  status: AutomationCardStatType,
  isZh: boolean,
): string

export function automationTestRunRequestFailed(message: string, isZh: boolean): string
export function automationTestRunFailed(raw: string, isZh: boolean): string
export function automationTestRunSkipped(duration: string, isZh: boolean): string
export function automationTestRunSucceeded(duration: string, isZh: boolean): string
```

`AutomationCardStatType` is deliberately not `AutomationStatus`: card stats are a 2-state delivery count (`ok` / `fail`), while execution status is `success` / `failed` / `skipped` / `running`.

`automationCardLinkLabel(...)` adds the clickable-action prefix (`Open public form: ${view}` / `打开公开表单：${view}`), while `automationCardLinkSummary(...)` returns the bare description form (`Public form: ${view}` / `公开表单：${view}`).

Behavior:

| Current EN | Target zh | Notes |
| --- | --- | --- |
| `When a record is created` | `当记录创建时` | Can delegate to `automationTriggerTypeLabel('record.created', isZh)`. |
| `When a record is updated` | `当记录更新时` | Delegate to existing trigger helper. |
| `When "${field}" changes` | `当“${field}”变化时` | Field name is raw; do not translate. |
| `When a field changes` | `当字段变化时` | No field ID fallback. |
| `Send notification` | `发送通知` | Delegate to `automationActionTypeLabel('notify', isZh)`. |
| `Update "${field}"` | `更新“${field}”` | Field name is raw; do not translate. |
| `Update field value` | `更新字段值` | Delegate to existing action helper for `update_field`. |
| `Update record` / `Create record` / `Send webhook` / `Lock record` | Existing zh labels | Delegate to `automationActionTypeLabel(...)`. |
| `Send DingTalk group/person message` | Existing zh labels | Card-level label in scope; DingTalk link suffix handled separately. |

Raw boundary: `fieldName` is user-defined data and must be passed through unmodified.

### 4.4 Test-Run Card Messages

Reuse T3D-1/T3D-2 status helpers where possible.

| Source | Current EN | Target zh | Key/helper |
| --- | --- | --- | --- |
| L1566-L1567 | `Running test.` | `正在运行测试。` | `manager.testRunning`; may embed `automationLabel('status.running', isZh)` but should have sentence-level copy. |
| L1566 | `Running test. DingTalk actions may send real messages.` | `正在运行测试。钉钉动作可能发送真实消息。` | `manager.testRunningDingTalkWarning` |
| L1551 | `Test run request failed: ${message}` | `测试运行请求失败：${message}` | `automationTestRunRequestFailed(message, isZh)` |
| L1586 | `Test run failed: ${raw}` | `测试运行失败：${raw}` | `automationTestRunFailed(raw, isZh)` |
| L1586 fallback | `At least one action failed.` | `至少一个动作失败。` | `manager.testRunAtLeastOneActionFailed` |
| L1592 | `Test run skipped${duration}.` | `测试运行已跳过${duration}。` | `automationTestRunSkipped(duration, isZh)` |
| L1597 | `Test run succeeded${duration}.` | `测试运行成功${duration}。` | `automationTestRunSucceeded(duration, isZh)` |

`duration` is a formatted technical value such as ` (32 ms)` and remains raw except for spacing/punctuation required by the surrounding sentence. Runtime/backend error messages remain raw.

Empty raw-boundary behavior:

- `automationTestRunRequestFailed(message, isZh)`: if `message.trim()` is empty, interpolate `automationLabel('error.unknown', isZh)`.
- `automationTestRunFailed(raw, isZh)`: if `raw.trim()` is empty, return `Test run failed: At least one action failed.` / `测试运行失败：至少一个动作失败。`; otherwise interpolate raw as-is.
- Helper spec must cover en raw, en empty, zh raw, and zh empty cases for both failure helpers.

### 4.5 useMultitableAutomations Fallbacks

`useMultitableAutomations.ts` is manager-domain because the manager is its only consumer.

| Source | Current fallback | Target zh | Key |
| --- | --- | --- | --- |
| L17 | `Failed to load automation rules` | `加载自动化规则失败` | `error.loadRules` |
| L32 | `Failed to create automation rule` | `创建自动化规则失败` | `error.createRule` |
| L46 | `Failed to update automation rule` | `更新自动化规则失败` | `error.updateRule` |
| L57 | `Failed to delete automation rule` | `删除自动化规则失败` | `error.deleteRule` |

Implementation rule:

```ts
error.value = e instanceof Error && e.message ? e.message : automationLabel('error.loadRules', isZh.value)
```

Backend/API `e.message` wins and stays raw. The localized string is only the frontend static fallback.

Locale wiring option: import `useLocale()` in the composable and read `isZh.value` at catch time. This keeps the call site stable and matches T3E-2 event-time toast semantics: already-stored errors do not retranslate after a locale toggle.

Composable-level `useLocale()` is preferred over passing `isZh` through each CRUD call because the composable owns the static fallback strings and the manager is its only consumer. This is an event-time error message, not a reactive render label; stored errors do not retranslate after a later locale toggle.

## 5. T3D-4 Deferred DingTalk Inventory

T3D-4 owns DingTalk-specific panel/helper copy shared across manager + rule editor:

- `Message preset`, `Form request`, `Internal processing`, `Form + processing`.
- `Add DingTalk groups`, `-- add DingTalk group --`, `Record group field paths`, `Pick group field`.
- `Search and add users or member groups`, person recipient states, inactive-user text.
- `Template tokens`, token button labels, preview labels, copy/copied states.
- `Public form view`, `Internal processing view`, access summary text from shared helpers.
- Warning helpers from `dingtalk*.ts`.
- Existing zh-only placeholders.

Scout-locked Manager zh-only placeholders for T3D-4:

| Source | Literal | Notes |
| --- | --- | --- |
| `MetaAutomationManager.vue:169` | `例如：{{record.title}} 待处理` | group title template placeholder |
| `MetaAutomationManager.vue:197` | `支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}` | group body template placeholder; extra scout finding beyond the earlier 6-line reminder |
| `MetaAutomationManager.vue:360` | `使用逗号或换行分隔本地 userId` | person local user IDs |
| `MetaAutomationManager.vue:368` | `使用逗号或换行分隔成员组 ID` | person member group IDs |
| `MetaAutomationManager.vue:376` | `例如：record.assigneeUserIds, record.reviewerUserId` | person recipient field path |
| `MetaAutomationManager.vue:421` | `例如：record.watcherGroupIds, record.escalationGroupId` | person member-group field path |
| `MetaAutomationManager.vue:466` | `例如：{{record.title}} 待处理` | person title template placeholder |
| `MetaAutomationManager.vue:494` | `支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}` | person body template placeholder; extra scout finding beyond the earlier 6-line reminder |

T3D-3 should not "fix" these opportunistically; doing so would force T3D-4 to rebase through the same DingTalk panel.

## 6. Raw Boundary

These remain raw:

- Rule names (`rule.name`), field names, view names, sheet IDs, view IDs, rule IDs.
- `data-*` attributes, `:data-*` values, and CSS suffix values.
- Persisted automation enum values in form controls.
- DingTalk group/user/member-group labels, subject IDs, subtitles, and status payloads.
- Public form access summaries returned by shared DingTalk helper utilities until T3D-4.
- Backend/API error messages from `e.message`.
- Runtime test-run error payloads from `execution.error`, `failedStep.error`, and `props.testRunState.message`.
- Template tokens and user-entered template strings.

M1 selector-binding trap:

- Do not bind localized labels into `data-automation-*`, `data-status`, `data-access-level`, or CSS suffix classes.
- Existing `:class="\`meta-automation__test-run-status--${status}\`"` and `:data-status="status"` stay raw.

## 7. A11y Boundary

T3D-3 localizes visible text and existing placeholders only. It must not add new a11y attributes.

Source counts before T3D-3:

- `aria-label=`: 0
- `title=`: 0
- `placeholder=`: 13

Test requirement:

- Add a fixture-render sentinel in `multitable-automation-manager.spec.ts` that records `[aria-label]`, `[title]`, and `[placeholder]` counts.
- Because T3D-3 may localize in-scope placeholder text without adding/removing attributes, the count should stay fixture-computed and explicitly asserted.
- Verification MD must record both source count and rendered fixture count.

## 8. Test Plan

### 8.1 Helper Spec

Extend `apps/web/tests/meta-automation-labels.spec.ts`:

- ALL_KEYS lockstep for new manager/error/testRun keys.
- `automationCardTriggerSummary(...)`: record created, record updated, field changed with raw field name, no-field fallback, unknown trigger raw fallback.
- `automationCardActionSummary(...)`: notify, update field with raw field name, update/create/webhook/lock, DingTalk action labels, unknown action raw fallback.
- Card link helpers for public form/internal view with raw view names.
- Test-run helpers: running, DingTalk warning, request failed with raw message, failed with raw message/fallback, skipped/succeeded with raw duration.
- Failure helpers must cover en raw, en empty, zh raw, and zh empty cases.
- Static CRUD fallback keys: `error.loadRules`, `error.createRule`, `error.updateRule`, `error.deleteRule`.
- Direct reuse proof: `automationLabel('status.running', false) === 'running'` and zh remains `运行中`.

### 8.2 Manager Render Spec

Extend `apps/web/tests/multitable-automation-manager.spec.ts`:

- en baseline for manager shell/card still renders expected English.
- zh-CN manager shell/list/card test: `自动化`, `+ 新建自动化`, `快速旧版表单`, `已启用` / `已停用`, `查看日志`, `查看投递记录`, `删除`.
- zh-CN quick legacy core test: `新建自动化`, `名称`, `触发器`, `动作`, `发送通知`, `更新字段值`, `通知内容`, `新值`, `创建`, `取消`.
- zh-CN card dynamic summary test: field name remains raw inside localized text.
- zh-CN DingTalk card-level test: `公开表单：Public Form`, `内部处理：Grid`, `打开公开表单：Public Form`, `允许范围：...`; shared access summary text remains raw/deferred if still English.
- zh-CN test-run status test: generic running, DingTalk warning, success/skipped/failed/request-failed strings; raw backend/test error messages remain raw.
- `useMultitableAutomations` fallback test: when API throws no message, localized frontend fallback appears; when API throws a message, raw message wins.
- Raw selector tests: `data-automation-rule`, `data-automation-toggle`, `data-status`, `data-access-level`, and option `value` attributes remain raw.
- A11y sentinel test: fixture `[aria-label]`, `[title]`, `[placeholder]` counts.

### 8.3 Validation Commands

Package-relative paths because `pnpm --filter @metasheet/web exec` runs with `apps/web` as cwd:

```bash
pnpm --filter @metasheet/web exec vitest run tests/meta-automation-labels.spec.ts tests/multitable-automation-manager.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
git diff --check
```

## 9. Preflight Grep

Before implementation, run:

```bash
rg -n "Automations|Edit Automation|New Automation|Automation name|When record created|When record updated|When field changes|-- select field --|Send notification|Update field value|Notification message|New value|Quick legacy form|Loading automations|No automations yet|Enabled|Disabled|Allowed audience| ok| fail|View Logs|View Deliveries|Running test|Test run succeeded|Test run failed|Test run skipped|Failed to load automation rules|Failed to create automation rule|Failed to update automation rule|Failed to delete automation rule" apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/src/multitable/composables/useMultitableAutomations.ts
```

Classify every hit:

- Localize in T3D-3.
- Raw runtime/user data; leave untouched.
- DingTalk deep panel/helper; explicitly defer to T3D-4.

Verification MD must include the grep command and a concise classification.

## 10. Implementation Order

1. Rebase first: `git fetch origin && git rebase origin/main`.
2. Run the T3D-3 preflight grep from §9.
3. Extend `meta-automation-labels.ts` with manager keys and dynamic helpers.
4. Extend `meta-automation-labels.spec.ts`.
5. Wire `useMultitableAutomations.ts` static frontend fallback errors.
6. Wire `MetaAutomationManager.vue` shell/card/legacy quick-form core chrome.
7. Wire card-level DingTalk labels only; do not enter deep config panel copy.
8. Wire test-run card messages.
9. Extend `multitable-automation-manager.spec.ts`.
10. Write verification MD with grep, test output, a11y counts, raw-boundary evidence, intra-module reuse grep, and proof that the 8 T3D-4 zh-only placeholders from §5 remain untouched in T3D-3.
11. Run validation commands.
12. Commit locally and stop before push.

## 11. Risk Register

| Risk | Mitigation |
| --- | --- |
| T3D-3 accidentally localizes deep DingTalk panel copy and collides with T3D-4. | Keep DingTalk config/token/warning/preview copy deferred except card-level labels explicitly listed in §4.2. |
| Card dynamic helpers translate user field/view names. | Helper signatures accept raw names and interpolate without mutation; specs assert raw field/view names. |
| `useMultitableAutomations` replaces backend `e.message` with localized fallback. | Raw `e.message` wins; only static no-message fallback localizes. |
| `data-*` or CSS suffix binds localized text. | Spec asserts raw `data-status`, `data-access-level`, option values, and selector attributes. |
| A11y boundary drifts. | Fixture sentinel locks `[aria-label]` / `[title]` / `[placeholder]` counts. |
| 4-PR chain modifies `meta-automation-labels.ts` across multiple slices; mid-flight rebase can conflict in union/map/ALL_KEYS. | Before push run `git fetch origin && git rebase origin/main`; if pushed PR becomes BEHIND and overlap is zero, Path A admin squash is acceptable; if automation label/module overlap exists, rebase + `--force-with-lease`. |
| T3D-3 consumes T3D-1/T3D-2 helpers that later drift. | Verification MD includes intra-module reuse grep for `automationStatusLabel`, `automationActionTypeLabel`, `automationTriggerTypeLabel`, and `automationLabel('status.running', ...)`. |

## 12. Approval Gate

Implementation is ready only if:

- `meta-automation-labels.ts` remains the single T3D module.
- Manager shell/card/legacy quick-form core chrome is localized.
- Deep DingTalk panel/helper copy remains T3D-4.
- `useMultitableAutomations` frontend fallback errors are localized while backend messages stay raw.
- Dynamic card helpers preserve raw field/view names.
- A11y count sentinel is present.
- `multitable-automation-manager.spec.ts` remains the only manager render harness.
- Validation commands pass and diff scope is limited to T3D-3 files.
