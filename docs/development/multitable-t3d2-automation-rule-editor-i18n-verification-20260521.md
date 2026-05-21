# T3D-2 Automation Rule Editor i18n Verification

Date: 2026-05-21

Branch: `docs/multitable-t3d2-rule-editor-i18n-design-20260521`

## 1. Definition Of Done

T3D-2 localizes the core automation rule editor chrome while preserving raw data, persisted enum values, and the deferred DingTalk detail panels.

Acceptance gates:

- `MetaAutomationRuleEditor.vue` core shell, trigger, condition, non-DingTalk action config, and test-run chrome are locale-aware.
- `meta-automation-labels.ts` owns all T3D automation labels and helpers; no cross-module reuse of `meta-manager-labels.ts` `action.*`.
- `ConditionOperatorOption` keeps its legacy `{ value, label }` shape, but the template renders labels from `automationConditionOperatorLabel(op.value, isZh)`.
- Existing behavior specs remain green, with zh-CN render assertions added for core editor chrome.
- A11y attribute counts are locked by fixture sentinel: no new `aria-label`, `title`, or `placeholder` attributes are introduced.
- No backend, contract, migration, attendance, K3, or workflow-manager scope is touched.

## 2. Files In Scope

Changed implementation files:

- `apps/web/src/multitable/utils/meta-automation-labels.ts`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Changed tests:

- `apps/web/tests/meta-automation-labels.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

Documentation:

- `docs/development/multitable-t3d2-automation-rule-editor-i18n-design-20260521.md`
- `docs/development/multitable-t3d2-automation-rule-editor-i18n-verification-20260521.md`

Out of scope:

- `MetaAutomationManager.vue` list/card manager chrome: T3D-3.
- DingTalk deep configuration panels and zh-only template placeholders: T3D-4.
- Automation final global audit: after T3D-2/3/4.

## 3. Preflight And Reachability

Preflight grep command:

```bash
rg -n "Edit Automation Rule|New Automation Rule|Automation name|When record created|When record updated|When record deleted|When field value changed|Schedule \(cron\)|Schedule \(interval\)|Webhook received|-- select field --|Any change|Changed to|Every 5 minutes|Every hour|Daily at midnight|Weekly \(Monday\)|Conditions|\+ Condition|\+ Add condition|Actions|Update record|Create record|Send webhook|Send notification|Send email|Lock record|Target sheet ID|Notification message|Use comma or newline separated email addresses|Save this automation before running a test|Saving\.\.\.|Test Run|Save failed" apps/web/src/multitable/components/MetaAutomationRuleEditor.vue
```

Post-wiring result:

- Core editor source no longer owns the in-scope static English labels directly.
- Remaining hits are structural comments, function names, or deferred DingTalk panel chrome.
- English baseline assertions remain in `apps/web/tests/multitable-automation-rule-editor.spec.ts` and are intentional.

Helper reachability command:

```bash
rg -n "automationTriggerTypeLabel\(|automationConditionOperatorLabel\(|automationConditionValuePlaceholder\(|automationTriggerConditionLabel\(|automationCronPresetLabel\(|automationActionTypeLabel\(|automationLabel\('status.running'" apps/web/src/multitable apps/web/tests
```

Reachability result:

- `automationTriggerTypeLabel` is used by trigger select options and covered by helper spec.
- `automationTriggerConditionLabel` is used by field-trigger condition options and covered by helper spec.
- `automationCronPresetLabel` is used by cron preset options and covered by helper spec.
- `automationConditionOperatorLabel` is used by condition operator display labels and covered by helper spec.
- `automationConditionValuePlaceholder` is used by condition value input placeholders and covered by helper spec.
- `automationActionTypeLabel` is used by action select options and covered by existing T3D-1 plus T3D-2 specs.
- `automationLabel('status.running', ...)` is covered directly to lock the key-backed running status branch.

## 4. Reminder Closure

Implementation reminders were handled as follows:

- `AutomationConditionValueWidget` is declared as an explicit 8-value union and has a sync comment pointing at the RuleEditor condition widget source.
- `ConditionOperatorOption` follows the light refactor path: the `label` field remains for compatibility, while rendering ignores it and uses `automationConditionOperatorLabel(op.value, isZh)`.
- Full-test-run confirm text uses the DRY two-key strategy: `testRun.warning` plus `testRun.confirmSuffix`.
- Existing English behavior assertions were preserved where locale defaults to `en`; new zh-CN assertions use `useLocale().setLocale('zh-CN')`.
- `status.running` is now backed by `automationLabel('status.running', isZh)` and has direct helper spec assertions.
- Unknown cron presets fall back to raw text, verified with `0 30 9 * *`.

## 5. Test Evidence

Targeted Vitest:

```bash
pnpm --filter @metasheet/web exec vitest run tests/meta-automation-labels.spec.ts tests/multitable-automation-rule-editor.spec.ts --reporter=dot
```

PASS:

```text
✓ tests/meta-automation-labels.spec.ts  (6 tests) 2ms
✓ tests/multitable-automation-rule-editor.spec.ts  (84 tests) 653ms

Test Files  2 passed (2)
Tests       90 passed (90)
```

Type check:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

PASS: exit 0, no output.

Build:

```bash
pnpm --filter @metasheet/web build
```

PASS:

```text
✓ built in 5.96s
```

The build still emits the existing Vite warnings for `WorkflowDesigner.vue` mixed dynamic/static import and chunk size. T3D-2 does not touch workflow designer import topology.

Whitespace:

```bash
git diff --check origin/main..HEAD
git diff --check
```

PASS: both clean.

## 6. A11y Sentinel

Representative RuleEditor fixture counts in `multitable-automation-rule-editor.spec.ts`:

- `[aria-label]`: `0`
- `[title]`: `1`
- `[placeholder]`: `1`

This locks the T3D-2 boundary: existing text may be localized, but this slice does not add new a11y attributes.

## 7. Raw Boundary

The following remain raw by design:

- Persisted enum values in `<option :value>` for trigger type, condition type, condition operator, cron preset, action type, and boolean options.
- `data-*` and CSS suffix values used by automation components.
- Field names, view names, rule names, sheet IDs, record IDs, user IDs, and group IDs.
- HTTP methods and user-entered URLs.
- Example template tokens such as `{{record.title}}` and `{{record.assigneeEmail}}`.
- Backend error messages, including save failures when `e.message` exists.
- `props.testRunState.message` output from test-run execution.
- DingTalk deep-panel data, tokens, and warnings deferred to T3D-4.

## 8. Dependency And Noise Notes

The fresh worktree reused the existing frontend dependency install through an ignored symlink:

```text
apps/web/node_modules -> /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules
```

No `node_modules` path is staged or part of the PR diff.

## 9. Result

T3D-2 is implementation-ready for review:

- Core RuleEditor chrome localized to zh-CN and en baseline preserved.
- T3D-1 label module extended instead of adding a second automation module.
- 90 targeted tests pass.
- `vue-tsc` and frontend build pass.
- Diff check is clean.
