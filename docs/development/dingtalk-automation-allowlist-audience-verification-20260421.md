# DingTalk Automation Allowlist Audience Verification

- Date: 2026-04-21
- Branch: `codex/dingtalk-automation-allowlist-audience-20260421`
- Status: passed local validation

## Local Validation Plan

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
rg -n "Allowed audience|audienceSummary|data-automation-public-form-audience|data-automation-card-link-audience|allowedUserIds|allowedMemberGroupIds" apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/src/multitable/components/MetaAutomationRuleEditor.vue apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts apps/web/tests/dingtalk-public-form-link-warnings.spec.ts apps/web/tests/multitable-automation-manager.spec.ts apps/web/tests/multitable-automation-rule-editor.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/development/dingtalk-automation-allowlist-audience-*.md
git diff --check
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false`: passed, 3 files and 132 tests.
- `pnpm --filter @metasheet/web build`: passed. Vite reported the existing large-chunk and mixed static/dynamic import warnings.
- `rg -n "Allowed audience|audienceSummary|data-automation-public-form-audience|data-automation-card-link-audience|allowedUserIds|allowedMemberGroupIds" ...`: passed, expected implementation/test/doc references found.
- `git diff --check`: passed.

## Expected Coverage

- Utility tests cover public, unavailable, DingTalk-bound, DingTalk-authorized, and allowlist-constrained audience summaries.
- Automation manager tests cover inline group/person summaries and rule-card public-form audience chips.
- Rule editor tests cover public-form selector audience badges and message summary previews.
- Build verifies Vue/TypeScript integration.
- `git diff --check` verifies whitespace safety.

## Notes

- Existing `node_modules` symlink changes from local dependency installation are intentionally excluded from this validation scope.

## Rebase Verification - 2026-04-22

Rebased `codex/dingtalk-automation-allowlist-audience-20260421` onto
`origin/main@0c86ecaa4` after PR #1029 was squash-merged.

```bash
git rebase --onto origin/main origin/codex/dingtalk-automation-allowlist-audience-base-20260421 HEAD
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
rg -n "Allowed audience|audienceSummary|data-automation-public-form-audience|data-automation-card-link-audience|allowedUserIds|allowedMemberGroupIds" apps/web/src/multitable/components/MetaAutomationManager.vue apps/web/src/multitable/components/MetaAutomationRuleEditor.vue apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts apps/web/tests/dingtalk-public-form-link-warnings.spec.ts apps/web/tests/multitable-automation-manager.spec.ts apps/web/tests/multitable-automation-rule-editor.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/development/dingtalk-automation-allowlist-audience-*.md
git diff --check
pnpm --filter @metasheet/web build
git checkout -- plugins/ tools/
```

Results:

- Rebase completed cleanly; replayed only the automation allowlist audience commit on top of main.
- `tests/dingtalk-public-form-link-warnings.spec.ts`: passed, 9 tests.
- `tests/multitable-automation-manager.spec.ts`: passed, 67 tests.
- `tests/multitable-automation-rule-editor.spec.ts`: passed, 56 tests.
- Combined target suite: passed, 3 files and 132 tests.
- `rg` guidance/search check: passed.
- `git diff --check`: passed.
- `pnpm --filter @metasheet/web build`: passed.
- Build warnings were limited to the existing `WorkflowDesigner.vue` mixed import warning and existing large chunk warnings.
- PNPM install recreated tracked plugin/tool `node_modules` symlink noise; it was cleaned with `git checkout -- plugins/ tools/` before pushing.
