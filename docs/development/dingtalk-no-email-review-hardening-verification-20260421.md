# DingTalk No-Email Review Hardening Verification 2026-04-21

Branch: `codex/dingtalk-no-email-review-hardening-20260421`

Base: `codex/no-email-user-closure-20260418` (`#916`)

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-auto-admission.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-auto-admission.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/unit/directory-sync-bind-account.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/AuthService.test.ts tests/unit/auth-login-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts tests/unit/directory-sync-auto-admission.test.ts --watch=false
git diff --check
git diff --cached --check
```

## Results

- `pnpm install --frozen-lockfile`: passed. Standard ignored build-script warning was emitted.
- Initial targeted test attempt before install failed because `vitest` was not present in the fresh worktree.
- Targeted backend tests: passed, `3 passed`, `26 passed`.
- Backend build: passed.
- `#916` backend regression subset: passed, `6 passed`, `139 passed`.
- Follow-up targeted backend tests after cross-field ambiguity fix: passed, `2 passed`, `23 passed`.
- Follow-up backend build: passed.
- Follow-up `#916` backend regression subset: passed, `6 passed`, `142 passed`.
- `git diff --check`: passed.
- `git diff --cached --check`: passed after staging the target source/test/doc files.

## Coverage

- Identifier login SQL no longer contains `COALESCE(email|username|mobile)` in indexed predicates.
- Manual directory binding by duplicate mobile reference fails closed with an explicit ambiguity error.
- Identifier login and manual directory binding fail closed when one input matches different users across email/username/mobile fields.
- Manual directory binding still permits an exact local user ID match even when another user's email/username/mobile also equals that same string.
- Directory sync local-user match map keeps only unique identifier matches and records duplicate keys as ambiguous.

## Not Run

- Frontend tests were not rerun because this slice did not change frontend code.
- No remote deployment or database migration execution was performed from this worktree.
