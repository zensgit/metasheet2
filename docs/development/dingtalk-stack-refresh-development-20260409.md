# DingTalk Stack Refresh Development

Date: 2026-04-09
Stack: `#725 -> #723 -> #724`

## Outcome

This pass moved the stack from "PR1 ready, downstream stale" to "PR1 ready, downstream branches refreshed onto the latest upstream heads".

## PR1 Gate Status

`#725` is now in the correct merge shape:

- latest head: `584fac083`
- full GitHub checks: green
- draft state: `false`
- merge state: `BLOCKED`
- remaining gate: human review / approval

No further code changes were made to PR1 in this pass.

## PR2 Refresh

Worktree:

- [dingtalk-phase2-20260408](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase2-20260408)

Action:

- rebased `codex/dingtalk-pr2-directory-sync-20260408` onto `origin/codex/dingtalk-pr1-foundation-login-20260408`

Observed behavior:

- the old PR1 commit `52aca0f86` was skipped as already applied
- the branch replay completed without conflicts

New PR2 head:

- `c683b7f79`

Validation run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalk-auth-callback.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
```

Validation result:

- backend tests passed
- frontend tests passed
- backend build passed
- web type-check passed

Push:

- force-pushed refreshed PR2 head to `origin/codex/dingtalk-pr2-directory-sync-20260408`
- GitHub PR state after push:
  - `#723`
  - `mergeStateStatus=CLEAN`
  - draft remains `true`
  - current remote head: `c683b7f79`

## PR3 Refresh

Worktree:

- [dingtalk-phase3-20260408](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408)

Action:

- rebased `codex/dingtalk-pr3-attendance-notify-20260408` onto `origin/codex/dingtalk-pr2-directory-sync-20260408`

Observed behavior:

- stale upstream commits from old PR1/PR2 history were skipped as already applied
- the rebase completed without conflicts

Refreshed PR3 branch state before this documentation commit:

- current branch tip: `7c6cc2db0`
- new upstream PR2 head under it: `c683b7f79`

Validation run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/notification-service-dingtalk.test.ts tests/unit/admin-users-routes.test.ts tests/unit/plugin-role-template.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts
pnpm --filter @metasheet/web exec vitest run tests/roleDelegationView.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/core-backend test:integration:attendance
```

Result:

- backend unit tests passed (`57/57`)
- frontend role delegation tests passed (`3/3`)
- backend build passed
- web type-check passed
- attendance integration tests passed (`66/66`)

Push:

- force-pushed refreshed PR3 head to `origin/codex/dingtalk-pr3-attendance-notify-20260408`
- GitHub PR state immediately after push:
  - `#724`
  - `mergeStateStatus=UNSTABLE`
  - draft remains `true`
  - `pr-validate` already passed
  - current remote head: `b579dd8a8`

## Next Actions

1. wait for PR1 approval and merge
2. retarget `#723` to `main`
3. once PR2 merges, retarget `#724` to `main`
4. keep live-tenant attendance / robot verification as a production gate, not a code-review gate
