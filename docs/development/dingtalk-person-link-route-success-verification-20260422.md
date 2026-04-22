# DingTalk Person Link Route Success Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-link-route-success-20260422`

## Local Verification

Passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false`
  - Result: passed, 1 file and 11 tests.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - Result: included in combined run below.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - Result: passed, 2 files and 23 tests.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.

## Expected Assertions

- Top-level DingTalk person-message automation create succeeds when public form and internal links are valid.
- Person-message create uses the same backend link validation path as group-message create.
- Legacy `title` / `content` fields normalize to `titleTemplate` / `bodyTemplate`.
- Existing invalid group/person link validation route tests still pass.

## Claude Code CLI

Passed:

- Command: `/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."`
- Result: no blockers.
- Findings:
  - Route create flow runs DingTalk action normalization, config validation, and link validation before `createRule`.
  - The new person-message success test reaches `createRule` only after valid `publicFormViewId` and `internalViewId` validation passes.
  - No production code change is required.
  - Development documentation accurately describes the coverage-only scope.

## Stack Rebase Verification - 2026-04-22

Rebased the single #1047 slice onto updated #1046 branch `origin/codex/dingtalk-form-allowlist-active-users-20260422` at `72b9a28f9ac70306a4e7c8880740873707cdd071`.

Scope after rebase:

- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- This development/verification note.

Passed:

- `pnpm install --frozen-lockfile`
  - Result: passed.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - Result: passed, 2 files and 23 tests.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.

## Main Rebase Verification - 2026-04-22

After PR #1046 was merged, rebased the single #1047 slice onto `origin/main` at `f7a69df4f0244b4463e4a941e87370296c119471`.

Scope after rebase:

- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- This development/verification note.

Passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - Result: passed, 2 files and 23 tests.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.
