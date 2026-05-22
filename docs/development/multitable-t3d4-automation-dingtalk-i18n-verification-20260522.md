# Multitable T3D-4 Automation DingTalk I18n Verification

Date: 2026-05-22
Branch: `frontend/multitable-t3d4-automation-dingtalk-i18n-20260522`
Base: `origin/main@64f77b597`

## DoD

- T3D-4 closes the automation DingTalk shared chrome slice.
- Scope is frontend i18n only: no backend, contract, migration, attendance, K3, or non-automation manager surfaces.
- T3D-4 extends the existing `meta-automation-labels.ts` module; no cross-module helper redeclare.
- DingTalk util functions keep English defaults; Vue consumers pass `isZh.value`.
- Raw boundaries stay raw: IDs, field/view names, token values, template text after insertion, backend errors, data attributes, and CSS selector values.
- A11y boundary stays structural: existing text/placeholder localization only, no new `aria-label` or `title` attributes.

## File Scope

Intended PR files: 18.

- Source: `MetaAutomationManager.vue`, `MetaAutomationRuleEditor.vue`, 7 DingTalk utility files, `meta-automation-labels.ts`.
- Tests: `meta-automation-labels.spec.ts`, 3 DingTalk utility specs, `multitable-automation-manager.spec.ts`, `multitable-automation-rule-editor.spec.ts`.
- Docs: this verification MD and `multitable-t3d4-automation-dingtalk-i18n-design-20260522.md`.

`pnpm install --frozen-lockfile` was required in this fresh worktree to restore local `node_modules`. It produced tracked `node_modules` symlink noise under plugin/tool folders; those paths are not staged and are not part of the intended PR diff.

## Preflight Grep

Planned DingTalk placeholder call-sites are wired to locale-aware labels:

```text
MetaAutomationManager.vue:169  dingtalk.titleTemplatePlaceholder
MetaAutomationManager.vue:197  dingtalk.bodyTemplatePlaceholder
MetaAutomationManager.vue:300  dingtalk.searchUsersOrGroupsPlaceholder
MetaAutomationManager.vue:360  dingtalk.localUserIdsPlaceholder
MetaAutomationManager.vue:368  dingtalk.memberGroupIdsPlaceholder
MetaAutomationManager.vue:376  dingtalk.recordRecipientFieldPathPlaceholder
MetaAutomationManager.vue:421  dingtalk.recordMemberGroupFieldPathPlaceholder
MetaAutomationManager.vue:466  dingtalk.titleTemplatePlaceholder
MetaAutomationManager.vue:494  dingtalk.bodyTemplatePlaceholder
MetaAutomationRuleEditor.vue:415  dingtalk.titleTemplatePlaceholder
MetaAutomationRuleEditor.vue:443  dingtalk.bodyTemplatePlaceholder
MetaAutomationRuleEditor.vue:567  dingtalk.searchUsersOrGroupsPlaceholder
MetaAutomationRuleEditor.vue:627  dingtalk.localUserIdsPlaceholder
MetaAutomationRuleEditor.vue:635  dingtalk.memberGroupIdsPlaceholder
MetaAutomationRuleEditor.vue:643  dingtalk.recordRecipientFieldPathPlaceholder
MetaAutomationRuleEditor.vue:688  dingtalk.recordMemberGroupFieldPathPlaceholder
MetaAutomationRuleEditor.vue:733  dingtalk.titleTemplatePlaceholder
MetaAutomationRuleEditor.vue:761  dingtalk.bodyTemplatePlaceholder
```

Static placeholder literals now live in `meta-automation-labels.ts` as paired `en`/`zh` entries. Component templates no longer carry the zh-only placeholder strings directly.

## Reuse / Reachability

Intra-module T3D helper reachability was verified with `rg` over the label module, Manager, RuleEditor, and DingTalk utilities.

- `automationDingTalkPresetLabel`: definition plus Manager and RuleEditor group/person preset buttons.
- `automationDingTalkTemplateTokenLabel`: definition plus `dingTalkTemplateTokenLabel()`, consumed by Manager and RuleEditor token buttons.
- `automationDingTalkDestinationScopeLabel` / `automationDingTalkDestinationSubtitle`: definitions plus Manager and RuleEditor group destination labels.
- `automationDingTalkPersonSubjectLabel` / `automationDingTalkPersonAccessLabel` / `automationDingTalkPersonStatusLabel`: definitions plus Manager and RuleEditor person candidate/chip labels.
- `automationDingTalkAllowlistSummary`: definition plus `dingtalkPublicFormLinkWarnings.ts`.

`AUTOMATION_LABEL_KEYS` remains unique and exhaustive through `meta-automation-labels.spec.ts`.

## Raw Boundary

Verified by code inspection and tests:

- `data-*` attributes remain raw persisted values (`data-access-level`, `data-automation-*`, selected IDs).
- DingTalk group destination IDs, local user IDs, member group IDs, field IDs, and view IDs are not translated.
- Field/view names remain raw user data, including Chinese view names in existing manager-card tests.
- Template token insertions remain raw: `{{recordId}}`, `{{sheetId}}`, `{{actorId}}`, `{{record.xxx}}`.
- Rendered example data is locale-specific demo data only; user-authored template text remains raw.
- Backend/API error messages continue to be surfaced raw; frontend static fallbacks are localized.
- Public form / internal view warning helpers preserve raw view names and IDs inside localized chrome.

## A11y Boundary

Source attribute count after implementation:

```text
MetaAutomationManager.vue + MetaAutomationRuleEditor.vue
[aria-label]  = 0
[title]       = 5
[placeholder] = 38
```

Representative fixture-render sentinel tests:

- `multitable-automation-manager.spec.ts` zh DingTalk person inline form: `[aria-label]/[title]/[placeholder] = 0/0/8`.
- `multitable-automation-rule-editor.spec.ts` zh DingTalk group editor: `[aria-label]/[title]/[placeholder] = 0/1/4`.
- Existing RuleEditor base fixture still locks `[aria-label]/[title]/[placeholder] = 0/1/1`.

No new `aria-label` or `title` attributes were added; this slice localizes existing visible text and placeholders.

## Tests

Target specs:

```text
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-automation-labels.spec.ts \
  tests/dingtalk-public-form-link-warnings.spec.ts \
  tests/dingtalk-recipient-field-warnings.spec.ts \
  tests/dingtalk-internal-view-link-warnings.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  tests/multitable-automation-rule-editor.spec.ts \
  --watch=false

Test Files  6 passed (6)
Tests       196 passed (196)
```

Coverage added:

- DingTalk label helpers: presets, template tokens, destination scopes/subtitles, person subject/access/status, allowlist summary, unknown raw fallbacks.
- DingTalk utility helpers: EN default and zh requested paths for public form link warnings, recipient field warnings, internal view warnings.
- Manager render: zh DingTalk inline form chrome, placeholders, token labels, preset output, template syntax warning, rendered example, and a11y sentinel.
- RuleEditor render: zh DingTalk group editor chrome, placeholders, token labels, preset output, rendered example, and a11y sentinel.
- Existing EN baseline tests updated to reflect utility EN defaults.

Type/build:

```text
pnpm --filter @metasheet/web run type-check
vue-tsc -b
exit 0

pnpm --filter @metasheet/web build
vue-tsc -b && vite build
✓ built in 6.26s
exit 0
```

`vite build` retains the existing WorkflowDesigner chunking warning; this slice does not touch workflow routing/chunk configuration.

## Diff Hygiene

```text
git diff --check -- . ':!**/node_modules/**'
exit 0
```

No `TODO`, `FIXME`, `console.log`, or `debugger` was introduced in the touched multitable automation/DingTalk files.

## Result

T3D-4 implementation is ready for implementation review. It completes DingTalk shared chrome localization while keeping T3D-1/2/3 helper/module discipline intact.
