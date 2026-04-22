# DingTalk Group Form Help Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-form-help-20260422`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false
pnpm --filter @metasheet/web build
rg -n "does not import DingTalk group members|control form access|target DingTalk group robot settings|appears in this table's automation rule editor|registered for this table|DingTalk group destination ID|No DingTalk group destinations yet|SEC secret" apps/web/src/multitable/components/MetaApiTokenManager.vue apps/web/src/multitable/components/MetaAutomationRuleEditor.vue apps/web/tests/multitable-api-token-manager.spec.ts apps/web/tests/multitable-automation-rule-editor.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md
git diff --check
claude -p --tools Read,Grep,Glob --max-budget-usd 0.75 "Read-only review. Inspect the current git diff for DingTalk group form/help text changes in apps/web and docs. Do not modify files. Report only concrete risks or say no blocking issues."
```

## Expected Coverage

- DingTalk Groups tab explains that table group bindings are robot webhook send destinations.
- DingTalk Groups tab states the binding does not import group members or control form access.
- The new group form explains where to get the webhook URL and how the access token is handled.
- The optional `SEC...` field explains DingTalk signature-security usage.
- Empty state tells users to add a group robot webhook before group-message automation.
- Automation rule editor explains that the group picker is scoped to the current table.
- Automation rule editor explains dynamic field paths must resolve to DingTalk group destination IDs.
- Frontend build validates Vue and TypeScript integration.

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false`: passed, 2 files and 77 tests.
- `pnpm --filter @metasheet/web build`: passed.
- `rg -n "does not import DingTalk group members|control form access|target DingTalk group robot settings|appears in this table's automation rule editor|registered for this table|DingTalk group destination ID|No DingTalk group destinations yet|SEC secret" ...`: passed, expected frontend/test/doc references found.
- `git diff --check`: passed.
- `claude -p --tools Read,Grep,Glob --max-budget-usd 0.75 ...`: passed as read-only review, no blocking issues reported.

## Claude Code CLI

- Local CLI check: `claude --version`
- Version observed: `2.1.117 (Claude Code)`
- Read-only review was executed with `Read,Grep,Glob` tools.
- Claude reported no blocking issues. Minor notes were copy redundancy and broader i18n consistency risks, which do not block this slice.

## Rebase verification - 2026-04-22

- Rebased onto `origin/codex/dingtalk-group-scope-guidance-20260422@8f659abc396c` after PR #1039 was replayed onto `main`.
- Rebased branch HEAD: `16a1aa78fa76`.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false`: passed, 2 files and 77 tests.
- `rg -n "does not import DingTalk group members|control form access|target DingTalk group robot settings|appears in this table's automation rule editor|registered for this table|DingTalk group destination ID|No DingTalk group destinations yet|SEC secret" ...`: passed.
- `git diff --check`: passed.
- `pnpm --filter @metasheet/web build`: passed. Vite emitted only existing chunk-size and mixed static/dynamic import warnings.

## Main rebase verification - 2026-04-22

- Rebased directly onto `origin/main@3c3dd1096f71` after PR #1039 was squash-merged.
- Rebased branch HEAD: `2f1ba9c63f54`.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts tests/multitable-automation-rule-editor.spec.ts --watch=false`: passed, 2 files and 77 tests.
- `rg -n "does not import DingTalk group members|control form access|target DingTalk group robot settings|appears in this table's automation rule editor|registered for this table|DingTalk group destination ID|No DingTalk group destinations yet|SEC secret" ...`: passed.
- `git diff --check`: passed.
- `pnpm --filter @metasheet/web build`: passed. Vite emitted only existing chunk-size and mixed static/dynamic import warnings.
