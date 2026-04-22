# DingTalk V1 Person Link Route Success Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-link-route-success-20260422`

## Local Verification

Passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false`
  - Result: passed, 1 file and 12 tests.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - Result: passed, 2 files and 24 tests.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.

## Expected Assertions

- V1 `actions[]` DingTalk person-message automation create succeeds when public form and internal links are valid.
- V1 person-message create uses the same backend normalization and link validation path as V1 group-message create.
- Legacy `title` / `content` fields inside `actions[]` normalize to `titleTemplate` / `bodyTemplate`.
- Existing invalid group/person link validation route tests still pass.

## Claude Code CLI

Passed:

- Command: `/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."`
- Result: no blockers.
- Findings:
  - The new test covers V1 `actionType: notify` with `actions[]` containing `send_dingtalk_person_message`.
  - Existing `meta_views` test fixtures resolve both valid public-form and internal-processing links before persistence.
  - The test asserts `title` / `content` normalization to `titleTemplate` / `bodyTemplate`.
  - No production code change is required.
  - Development documentation accurately describes the coverage-only scope.

## Main Rebase Verification - 2026-04-22

Rebased the single #1048 slice onto `origin/main` at `9a8f5e28bf3087b6eba96bf9af6ef78f44340d85`.

Scope after rebase:

- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- This development/verification note.

Passed:

- `pnpm install --frozen-lockfile`
  - Result: passed.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - Result: passed, 2 files and 24 tests.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.
