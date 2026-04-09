# DingTalk Stack Acceleration Development

Date: 2026-04-09
Stack: `#725 -> #723 -> #724`

## Actions Completed

### PR1 refresh

`#725` was refreshed onto the latest `origin/main` in a clean temporary worktree so existing unrelated local edits in the original PR1 worktree were not touched.

Refresh sequence:

1. create detached clean worktree from `codex/dingtalk-pr1-foundation-login-20260408`
2. rebase PR1 head onto `origin/main`
3. install workspace dependencies in the temporary worktree
4. rerun the narrow PR1 validation set
5. force-push refreshed head back to `codex/dingtalk-pr1-foundation-login-20260408`

Initial result:

- pre-refresh head: `f31d89eaf`
- refreshed head: `75be0891a`
- new base head during refresh: `origin/main @ 5e4b8ee48`

### PR1 review-fix follow-up

After the initial refresh, PR1 needed three additional review-fix passes:

1. `68d5d6d85`
   - block DingTalk login for disabled or inactive local users
   - write bcrypt `password_hash` for auto-provisioned users
2. `cc97a9913`
   - refresh the same fixes onto the newer `origin/main`
3. `584fac083`
   - scope fallback external-identity lookups to the configured `corpId`

Current PR1 head after the final follow-up:

- `#725` head: `584fac083`
- merge state: `BLOCKED`
- review state: `REVIEW_REQUIRED`
- GitHub checks: full required set green

### Validation completed after rebase

Commands run:

```bash
pnpm install --offline --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/dingtalk-oauth-state-store.test.ts
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-auth-callback.spec.ts tests/LoginView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
```

Results:

- backend PR1 unit tests passed
- frontend PR1 unit tests passed
- backend build passed
- web type-check passed

### Validation completed after review-fix follow-up

Commands rerun on the latest PR1 head:

```bash
pnpm install --offline --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/dingtalk-oauth-state-store.test.ts
pnpm --filter @metasheet/core-backend build
```

Results:

- backend review-fix unit tests passed (`21/21`)
- backend build passed
- GitHub full checks on `#725` are green

### PR metadata preparation

Current stack handling after this pass:

- `#725`: remains `Ready for review`, fully green, blocked only on human review / approval
- `#723`: stays draft on `codex/dingtalk-pr1-foundation-login-20260408`, waiting for `#725` merge before retarget to `main`
- `#724`: stays draft on `codex/dingtalk-pr2-directory-sync-20260408`, waiting for `#723` merge before retarget to `main`

### Retarget readiness snapshot

- `#723`
  - base: `codex/dingtalk-pr1-foundation-login-20260408`
  - current GitHub merge state: `DIRTY`
  - current checks: `pr-validate` only
  - planned action: retarget only after `#725` merges
- `#724`
  - base: `codex/dingtalk-pr2-directory-sync-20260408`
  - current GitHub merge state: `CLEAN`
  - current checks: `pr-validate` only
  - planned action: retarget only after `#723` merges

## Next Execution Steps

### After `#725` merges

1. retarget `#723` to `main`
2. rerun full GitHub checks
3. fix only retarget-induced issues
4. mark `#723` ready once checks and diff are clean

### After `#723` merges

1. retarget `#724` to `main`
2. rerun full GitHub checks
3. fix only retarget-induced issues
4. keep attendance/notification live-tenant validation as a production gate, not a code-review gate
