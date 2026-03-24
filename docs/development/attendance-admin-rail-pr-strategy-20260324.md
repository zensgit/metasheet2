# Attendance Admin Rail PR Strategy 2026-03-24

## Context

The attendance admin rail work on `codex/attendance-root-admin-nav-20260323` is functionally coherent and locally verified, but it is not sitting on a reviewable branch boundary for a direct PR to `main`.

The rail branch currently contains:

- root admin console stabilization
- hash deep links
- grouped rail navigation
- collapse persistence
- compact/mobile rail behavior
- current-section share links
- recent shortcuts
- active-link visibility
- last-section restore
- org-scoped rail persistence
- org scope badge and scope-change note
- current-section context summary
- recent shortcut context labels
- recent shortcut reset

## Constraint Summary

### 1. Direct PR to `main` is not reviewable

After fetching `origin`, the branch delta against `origin/main` is still large:

- `git rev-list --left-right --count origin/main...HEAD`
- result: `251 66`

GitHub compare also confirms the branch is not a small direct PR candidate. The public compare view reports that the comparison is too large / not directly usable as a straightforward pull request path for this branch.

### 2. GitHub CLI auth is currently unusable

`gh auth status` currently reports an invalid token for the active account, so `gh pr create` and even `gh pr list` are blocked with `401 Bad credentials`.

### 3. GitHub Web is logged out in browser automation

The GitHub Web session available to browser automation is also logged out, so PR creation cannot be completed through the web UI in this session without re-authentication.

### 4. A “fresh branch from main” cherry-pick is not safe

The earliest rail bootstrap commit, `df2c43560 feat(attendance): stabilize root admin console`, is not UI-only. It also bundles:

- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/rbac/rbac.ts`
- `packages/core-backend/src/routes/attendance-admin.ts`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `plugins/plugin-attendance/index.cjs`

Cherry-picking that commit onto a fresh branch from `origin/main` or `origin/codex/attendance-postrelease-next-20260322` immediately creates conflicts in backend files, which means it is not a clean PR extraction unit.

## Claude Code Guidance

Claude Code CLI was used to sanity-check the branch strategy. The relevant conclusion was:

- the lowest-risk PR strategy is a fresh branch from the intended attendance base
- then cherry-pick only the focused rail commits
- validate with targeted frontend tests, `vue-tsc`, and production build before opening the PR

That recommendation is correct in principle, but the current commit history prevents it from being one-step executable because the first rail bootstrap commit mixes frontend rail setup with unrelated backend stabilization.

## Recommended Path

### Option A. Attendance-base PR, not `main` PR

If the intended review base is the broader attendance branch rather than `main`, keep using `codex/attendance-root-admin-nav-20260323` and open the PR from a session that has valid GitHub auth. This is the fastest path.

Use this when:

- reviewer context already includes the attendance branch
- the goal is to review the rail as part of the larger attendance line

### Option B. True clean PR extraction

If the goal is a small standalone PR, first split the rail into a dedicated component/composable on top of the target attendance base, then move only that componentized delta into a fresh branch.

That extraction should:

- isolate rail template/UI state from the rest of `AttendanceView.vue`
- avoid dragging the early mixed backend/UI bootstrap commit
- reduce the final compare from a monolithic `AttendanceView.vue` rewrite into a bounded component diff

## Immediate Next Step

The next correct engineering step is:

1. re-authenticate GitHub (`gh` or web)
2. decide whether review target is `main` or the broader attendance branch
3. if `main` is required, do a dedicated component extraction first
4. if attendance-base review is acceptable, open the PR from the existing verified branch

## Branches Involved

- Verified working branch: `codex/attendance-root-admin-nav-20260323`
- Investigation branch from `main`: `codex/attendance-root-admin-nav-clean-20260324`
- Investigation branch from attendance base: `codex/attendance-root-admin-nav-pr-20260324`

The two investigation branches were used only to prove PR extraction risk; they are not the recommended delivery branch in their current state.
