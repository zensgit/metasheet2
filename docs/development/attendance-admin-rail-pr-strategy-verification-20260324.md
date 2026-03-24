# Attendance Admin Rail PR Strategy Verification 2026-03-24

## Scope Verified

This verification covers the PR-extraction investigation for the attendance admin rail work currently living on `codex/attendance-root-admin-nav-20260323`.

It verifies:

- the branch cannot currently be opened as a small direct PR to `main`
- GitHub CLI auth is currently broken for the active shell
- GitHub Web is logged out in browser automation
- the first rail bootstrap commit is not a frontend-only extraction unit
- a fresh branch from the attendance base is the correct lower-risk direction, even though the first bootstrap commit still blocks immediate clean cherry-pick

## Commands And Results

### 1. Check branch delta against `origin/main`

```bash
git -C /Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-root-admin-nav-followup-20260323 fetch origin
git -C /Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-root-admin-nav-followup-20260323 rev-list --left-right --count origin/main...HEAD
```

Result:

- `251 66`

This confirms the branch is not sitting on a narrow PR boundary relative to `main`.

### 2. Check `gh` authentication

```bash
gh auth status
gh pr list --head codex/attendance-root-admin-nav-20260323 --json number,title,url,state
```

Result:

- `gh auth status` reports an invalid keyring token for `zensgit`
- `gh pr list` fails with `HTTP 401: Bad credentials`

This blocks `gh pr create` and all normal GitHub CLI PR actions in the current shell session.

### 3. Check GitHub Web session via browser automation

Visited:

- `https://github.com/zensgit/metasheet2/compare/main...codex/attendance-root-admin-nav-20260323?expand=1`

Observed result:

- browser automation is presented with GitHub sign-in UI
- the compare page is visible only in logged-out mode
- PR creation cannot be completed in this session without web re-authentication

### 4. Validate bootstrap commit contents

```bash
git -C /Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-root-admin-nav-pr-20260324 show --name-only --format=medium df2c43560
```

Result:

The bootstrap commit touches both frontend and backend files, including:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `apps/web/tests/attendance-import-batch-timezone-status.spec.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/rbac/rbac.ts`
- `packages/core-backend/src/routes/attendance-admin.ts`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `plugins/plugin-attendance/index.cjs`

This proves the first rail bootstrap commit is not safe to cherry-pick as a UI-only extraction unit.

### 5. Attempt clean cherry-pick from `origin/main`

Created investigation branch:

- `codex/attendance-root-admin-nav-clean-20260324`

Attempted:

```bash
git -C /Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-root-admin-nav-clean-20260324 cherry-pick df2c43560 f9adbb214 29fed9335 04a161af8 a7113eabd ff8adf143 d561c87a7 bd12b722f 3ad97c759 20ed85e48 9ec851217 38068dccd 38e6b3713 0e0f3cb1c f31c1608d
```

Result:

- immediate conflicts in `AttendanceView.vue`
- immediate conflicts in backend auth/RBAC/attendance plugin files

Conclusion:

- direct clean extraction from `main` is not currently one-step executable

### 6. Attempt clean cherry-pick from attendance base

Created investigation branch:

- `codex/attendance-root-admin-nav-pr-20260324`
- base: `origin/codex/attendance-postrelease-next-20260322`

Attempted the same cherry-pick sequence.

Result:

- the same first bootstrap commit still conflicts in frontend and backend files

Conclusion:

- using the attendance base is directionally correct
- but the mixed bootstrap commit still prevents a trivial cherry-pick workflow

### 7. Claude Code strategy check

Command:

```bash
claude -p "Given a feature branch with attendance admin rail commits layered on top of a larger attendance branch, is a fresh branch from origin/codex/attendance-postrelease-next-20260322 plus cherry-picking only the rail commits the lowest-risk PR strategy? Answer in 5 lines max."
```

Result summary:

- Claude Code agreed this is the lowest-risk PR strategy in principle
- it recommended a fresh branch from the intended attendance base
- then cherry-picking only focused rail commits
- followed by targeted frontend validation

That recommendation is consistent with the local investigation, but the mixed bootstrap commit means an extra extraction step is still required.

## Verified Conclusion

The attendance admin rail branch is verified as functionally ready but structurally not ready for a small direct PR to `main`.

The currently verified delivery choices are:

1. Re-authenticate GitHub and open a PR from `codex/attendance-root-admin-nav-20260323` against the broader attendance review branch if that review model is acceptable.
2. If a true small PR is required, first extract the rail into a dedicated component/composable on top of the attendance base, then create a fresh branch from that base and move only the extracted delta.

## Notes

- No runtime code was changed in this investigation step.
- The two investigation branches were created only to verify extraction feasibility.
- The already-verified implementation branch remains `codex/attendance-root-admin-nav-20260323`.
