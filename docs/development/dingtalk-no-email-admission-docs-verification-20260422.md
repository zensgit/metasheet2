# DingTalk No-Email Admission Docs Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-no-email-docs-20260422`
- Scope: docs-only correction for DingTalk synced-account local-user admission

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-auto-admission.test.ts tests/unit/admin-directory-routes.test.ts --watch=false
git diff --check
rg -n "email is still required|still requires email|skips missing-email|cannot yet directly admit|No-email.*Pending|optional no-email admission|dingtalk-status-docs-20260420" docs/dingtalk-capability-status-matrix-20260420.md docs/dingtalk-synced-account-local-user-guide-20260420.md
/Users/chouhua/.local/bin/claude -p --tools Read,Grep,Glob --max-budget-usd 1.5 "Read-only review current git diff ..."
```

## Results

- `directory-sync-auto-admission.test.ts` and `admin-directory-routes.test.ts`: passed, 27 tests.
- `git diff --check`: passed.
- Stale/incorrect docs phrase search: no matches.
- Claude Code CLI read-only review: no blockers.

## Claude Code CLI Review Summary

Claude verified the docs against code evidence:

- Manual admission accepts `name + email/username/mobile`.
- No-email manual admission is supported.
- Auto-admission creates no-email users with generated usernames and onboarding packets.
- Touched docs no longer contain stale `.worktrees` absolute links.

## Residual Risk

This change only corrects documentation. It does not add new runtime behavior.

## Stack Rebase Verification - 2026-04-22

Rebased the single #1049 docs slice onto updated #1048 branch `origin/codex/dingtalk-v1-person-link-route-success-20260422` at `1e8713a87161238710c2891dcc890b7ffe0360f1`.

Scope after rebase:

- `docs/dingtalk-capability-status-matrix-20260420.md`
- `docs/dingtalk-synced-account-local-user-guide-20260420.md`
- This development/verification note.

Passed:

- `pnpm install --frozen-lockfile`
  - Result: passed.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-auto-admission.test.ts tests/unit/admin-directory-routes.test.ts --watch=false`
  - Result: passed, 2 files and 27 tests.
- `rg -n "email is still required|still requires email|skips missing-email|cannot yet directly admit|No-email.*Pending|optional no-email admission|dingtalk-status-docs-20260420" docs/dingtalk-capability-status-matrix-20260420.md docs/dingtalk-synced-account-local-user-guide-20260420.md`
  - Result: no matches.
- `git diff --check`
  - Result: passed.

## Main Rebase Verification - 2026-04-22

After PR #1048 was merged, rebased the single #1049 docs slice onto `origin/main` at `fa51ad01bfccb638889210add3d38b4aedf8d28b`.

Scope after rebase:

- `docs/dingtalk-capability-status-matrix-20260420.md`
- `docs/dingtalk-synced-account-local-user-guide-20260420.md`
- This development/verification note.

Passed:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-auto-admission.test.ts tests/unit/admin-directory-routes.test.ts --watch=false`
  - Result: passed, 2 files and 27 tests.
- `rg -n "email is still required|still requires email|skips missing-email|cannot yet directly admit|No-email.*Pending|optional no-email admission|dingtalk-status-docs-20260420" docs/dingtalk-capability-status-matrix-20260420.md docs/dingtalk-synced-account-local-user-guide-20260420.md`
  - Result: no matches.
- `git diff --check`
  - Result: passed.
