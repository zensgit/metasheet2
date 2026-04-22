# DingTalk Form Allowlist Active Users Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-form-allowlist-active-users-20260422`

## Local Verification

Passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false`
  - Result: passed, 1 file and 17 tests.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false`
  - Result: passed, 1 file and 15 tests.
  - Notes: Vitest printed a non-failing WebSocket port-in-use warning.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.

## Expected Assertions

- Protected form-share updates reject inactive local users in `allowedUserIds`.
- Unknown allowed-user validation remains unchanged.
- Existing protected public-form allowlist updates still pass.
- Frontend form-share manager behavior remains compatible with the backend constraint.

## Claude Code CLI

Passed:

- Command: `/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."`
- Result: no blockers.
- Findings:
  - PATCH inactive-user rejection preserves the existing unknown-user path.
  - Inactive users are rejected after existence validation, so they are not mislabeled as unknown users.
  - Clearing allowlists still works because validation only runs when `allowedUserIds` is non-empty.
  - Existing happy-path test mocks cover the widened `SELECT id, is_active` query shape.
  - Non-blocking note: one defensive inactive-row filter is redundant but harmless.

## Main Rebase Verification - 2026-04-22

Rebased the single #1046 slice onto `origin/main` at `15f06cc3d15c9a7b2b0f012013f739fa95af0e2b`.

Scope after rebase:

- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/public-form-flow.test.ts`
- DingTalk admin/capability docs and this development/verification note.

Passed:

- `pnpm install --frozen-lockfile`
  - Result: passed.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false`
  - Result: passed, 1 file and 17 tests.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false`
  - Result: passed, 1 file and 15 tests.
  - Notes: Vitest printed a non-failing WebSocket port-in-use warning.
- `pnpm --filter @metasheet/core-backend build`
  - Result: passed.
- `git diff --check`
  - Result: passed.
