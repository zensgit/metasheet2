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
