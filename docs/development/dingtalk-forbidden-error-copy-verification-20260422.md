# DingTalk Forbidden Error Copy Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-forbidden-error-copy-20260422`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-api-token-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
rg -n "defaultApiErrorMessage|Insufficient permissions|FORBIDDEN|code-only forbidden|DingTalk group loading is forbidden" apps/web/src/multitable/api/client.ts apps/web/tests/multitable-client.spec.ts apps/web/tests/multitable-api-token-manager.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-forbidden-error-copy-*.md
git diff --check
```

## Expected Coverage

- Code-only `FORBIDDEN` responses from DingTalk group list requests produce `Insufficient permissions`.
- Legacy string error envelopes still produce the original string message.
- `MetaApiTokenManager` shows `Insufficient permissions` when DingTalk group loading is denied.
- Field-level errors remain higher priority than backend messages and code fallback.
- Existing DingTalk Groups panel permission gating tests still pass.
- Frontend build verifies TypeScript integration.

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-api-token-manager.spec.ts --watch=false`: passed, 2 files and 37 tests.
- `pnpm --filter @metasheet/web build`: passed.
- `rg -n "defaultApiErrorMessage|Insufficient permissions|FORBIDDEN|code-only forbidden|DingTalk group loading is forbidden" ...`: passed, expected frontend/test/doc references found.
- `git diff --check`: passed.

## Claude Code CLI

- Local CLI check: `claude --version`
- Version observed: `2.1.117 (Claude Code)`
- A read-only `claude -p` attempt was made with `--max-budget-usd 0.25`; it exited with `Exceeded USD budget (0.25)` before returning analysis. Claude Code CLI did not edit files.

## Rebase Verification - 2026-04-22

Rebased `codex/dingtalk-forbidden-error-copy-20260422` onto `origin/main@0c46bdeb6`
after PR #1037 was squash-merged.

```bash
git rebase --onto origin/main origin/codex/dingtalk-forbidden-error-copy-base-20260422 HEAD
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-api-token-manager.spec.ts --watch=false
rg -n "defaultApiErrorMessage|Insufficient permissions|FORBIDDEN|code-only forbidden|DingTalk group loading is forbidden" apps/web/src/multitable/api/client.ts apps/web/tests/multitable-client.spec.ts apps/web/tests/multitable-api-token-manager.spec.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-forbidden-error-copy-*.md
git diff --check
pnpm --filter @metasheet/web build
git checkout -- plugins/ tools/
```

Results:

- Rebase completed cleanly; replayed only the readable forbidden error copy commit on top of main.
- `tests/multitable-client.spec.ts`: passed, 16 tests.
- `tests/multitable-api-token-manager.spec.ts`: passed, 21 tests.
- Combined target suite: passed, 2 files and 37 tests.
- `rg` frontend/test/doc check: passed.
- `git diff --check`: passed.
- `pnpm --filter @metasheet/web build`: passed.
- Build warnings were limited to the existing `WorkflowDesigner.vue` mixed import warning and existing large chunk warnings.
- PNPM install recreated tracked plugin/tool `node_modules` symlink noise; it was cleaned with `git checkout -- plugins/ tools/` before pushing.
