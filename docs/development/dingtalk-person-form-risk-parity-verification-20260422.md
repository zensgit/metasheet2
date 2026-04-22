# DingTalk Person Form Risk Parity Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-form-risk-parity-20260422`

## Local Verification

Passed:

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts tests/dingtalk-public-form-link-warnings.spec.ts --watch=false`
  - Result: passed, 3 files and 136 tests.
- `pnpm --filter @metasheet/web build`
  - Result: passed.
  - Notes: Vite reported existing non-failing dynamic-import and chunk-size warnings.
- `git diff --check`
  - Result: passed.

## Expected Assertions

- Advanced rule editor warns when a DingTalk person message includes a fully public form link.
- Advanced rule editor warns when a DingTalk person message uses a DingTalk-protected form without local allowlists.
- Inline automation manager warns for the same two person-message risk cases.
- Existing access summary and allowed-audience badges remain unchanged.
- Save blocking still depends on blocking link errors, not advisory risk warnings.

## Claude Code CLI

Passed:

- Command: `/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."`
- Result: no blockers.
- Findings:
  - `MetaAutomationRuleEditor.vue` person path now mirrors group path for fully public and protected-without-allowlist advisory warnings.
  - `MetaAutomationManager.vue` inline person path now mirrors group path for the same warnings.
  - Save blocking remains tied to `publicFormLinkBlockingErrors`; advisory warnings do not block submit.
