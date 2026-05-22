# T3D-3 Automation Manager I18n Verification - 2026-05-21

## DoD

T3D-3 localizes the automation manager shell, card summaries, card-level DingTalk links, test-run card messages, and `useMultitableAutomations` static frontend fallback errors without touching backend contracts, migrations, K3, attendance, RuleEditor deep DingTalk panel copy, or T3D-4 placeholder scope.

Result: PASS.

## Scope

Changed production surfaces:

- `apps/web/src/multitable/utils/meta-automation-labels.ts`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/composables/useMultitableAutomations.ts`

Changed tests:

- `apps/web/tests/meta-automation-labels.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

Docs:

- `docs/development/multitable-t3d3-automation-manager-i18n-design-20260521.md`
- `docs/development/multitable-t3d3-automation-manager-i18n-verification-20260521.md`

Out of scope and unchanged: RuleEditor deep DingTalk panel copy, `dingtalk*.ts` warning/token helpers, automation backend/API contracts, migrations, attendance, K3, and final global audit.

## Preflight And Reuse Grep

Preflight source grep confirmed the T3D-3 chrome strings came from `MetaAutomationManager.vue` and `useMultitableAutomations.ts`, while deep DingTalk panel strings remained intentionally deferred to T3D-4.

Intra-module reuse evidence:

```text
apps/web/src/multitable/utils/meta-automation-labels.ts:412:export function automationStatusLabel(...)
apps/web/src/multitable/utils/meta-automation-labels.ts:420:export function automationActionTypeLabel(...)
apps/web/src/multitable/utils/meta-automation-labels.ts:446:export function automationTriggerTypeLabel(...)
apps/web/src/multitable/utils/meta-automation-labels.ts:389:'manager.testRunning'
apps/web/src/multitable/utils/meta-automation-labels.ts:390:'manager.testRunningDingTalkWarning'
apps/web/src/multitable/components/MetaAutomationManager.vue:1829:automationCardTriggerSummary(...)
apps/web/src/multitable/components/MetaAutomationManager.vue:1852:automationCardActionSummary(...)
apps/web/src/multitable/components/MetaAutomationManager.vue:1257:automationCardLinkLabel(...)
apps/web/src/multitable/components/MetaAutomationManager.vue:1878:automationCardLinkSummary(...)
```

New T3D-3 helpers are covered by `meta-automation-labels.spec.ts` and wired in `MetaAutomationManager.vue`:

- `automationCardTriggerSummary`
- `automationCardActionSummary`
- `automationCardLinkLabel`
- `automationCardLinkSummary`
- `automationCardStats`
- `automationTestRunRequestFailed`
- `automationTestRunFailed`
- `automationTestRunSkipped`
- `automationTestRunSucceeded`

## Deferred Placeholder Check

The 8 zh-only DingTalk placeholders discovered during T3D-3 scout remain untouched for T3D-4:

```text
MetaAutomationManager.vue:169 placeholder="例如：{{record.title}} 待处理"
MetaAutomationManager.vue:197 placeholder="支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}"
MetaAutomationManager.vue:360 placeholder="使用逗号或换行分隔本地 userId"
MetaAutomationManager.vue:368 placeholder="使用逗号或换行分隔成员组 ID"
MetaAutomationManager.vue:376 placeholder="例如：record.assigneeUserIds, record.reviewerUserId"
MetaAutomationManager.vue:421 placeholder="例如：record.watcherGroupIds, record.escalationGroupId"
MetaAutomationManager.vue:466 placeholder="例如：{{record.title}} 待处理"
MetaAutomationManager.vue:494 placeholder="支持 {{record.xxx}}、{{recordId}}、{{sheetId}}、{{actorId}}"
```

Source a11y count for `MetaAutomationManager.vue` after T3D-3:

- `aria-label`: 0
- `title`: 0
- `placeholder`: 13

Fixture-render sentinel in `multitable-automation-manager.spec.ts` locks:

- quick-form zh fixture `[aria-label] = 0`
- quick-form zh fixture `[title] = 0`
- quick-form zh fixture `[placeholder] = 2`

The source count is higher than fixture count because DingTalk panel placeholders are conditional and deferred to T3D-4.

## Raw Boundary

Raw values preserved:

- Rule name (`Raw 规则名`)
- Field/view names (`Status`, `Name`, `我的视图`, `内部视图`)
- `data-automation-rule`, `data-automation-field`, `data-access-level`, and other raw selectors
- DingTalk public-form access summary text from lower-level helpers
- Backend/API error messages when present
- `duration` string such as ` (32 ms)` without trimming
- Test-run raw failed step error text
- Unknown enum fallbacks via `String(value)`

New fallback-only frontend errors localize through `useMultitableAutomations`:

- `error.loadRules`
- `error.createRule`
- `error.updateRule`
- `error.deleteRule`

This is the first metasheet2 multitable i18n slice that consumes `useLocale()` inside a composable. It is called once at composable creation time (`const { isZh } = useLocale()`), and catch blocks read `isZh.value` at event time. Stored `error.value` is an event-time string and does not retranslate after a later locale toggle.

## Test Evidence

Targeted T3D suite:

```text
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-automation-labels.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  tests/multitable-automation-rule-editor.spec.ts \
  tests/MetaAutomationLogViewer.spec.ts \
  tests/meta-automation-delivery-viewers-i18n.spec.ts \
  --watch=false

✓ tests/meta-automation-labels.spec.ts (8 tests)
✓ tests/meta-automation-delivery-viewers-i18n.spec.ts (4 tests)
✓ tests/MetaAutomationLogViewer.spec.ts (17 tests)
✓ tests/multitable-automation-manager.spec.ts (78 tests)
✓ tests/multitable-automation-rule-editor.spec.ts (84 tests)

Test Files 5 passed (5)
Tests 191 passed (191)
```

Type-check:

```text
pnpm --filter @metasheet/web type-check

> vue-tsc -b
exit=0
```

Build:

```text
pnpm --filter @metasheet/web build

> vue-tsc -b && vite build
✓ built in 5.87s
```

The Vite build emitted the existing chunk-size/dynamic-import warnings; no T3D-3-specific build error occurred.

Diff whitespace check for intended source/docs files:

```text
git diff --check -- apps/web/src/multitable apps/web/tests docs/development
exit=0
```

## Node Modules Note

This separate worktree initially had no `vitest` executable, so `pnpm install --ignore-scripts` was run to create local workspace executables before validation. It modified tracked `node_modules` symlinks under plugin/tool folders in the worktree. These paths are not staged and are not part of the intended PR diff.

Before commit/push, use targeted `git add` for the seven T3D-3 files only.
