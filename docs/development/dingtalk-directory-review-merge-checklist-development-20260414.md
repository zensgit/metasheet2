# DingTalk Directory Review Merge Checklist

## Pre-Merge

- Confirm the PR contains only the DingTalk directory review workflow and doc package
- Re-read the known backend workspace type-check blocker note so reviewers do not treat it as a regression from this PR
- Confirm unrelated untracked items remain excluded:
  - `.claude/`
  - `apps/web/tests/sessionCenterView.spec.ts`

## Review Checklist

- Backend
  - alert list and ack routes are scoped to platform admins
  - review-item list returns counts and queue metadata
  - batch bind deduplicates by account and writes audit logs
  - batch unbind preserves optional grant disable semantics
  - bulk DingTalk grant and namespace admission routes validate user IDs before mutation
- Frontend
  - alerts section refreshes independently from account list
  - review queue selection and batch actions follow the active queue state
  - quick bind and candidate search do not leak stale drafts across accounts
  - user-management bulk actions refresh the current detail user after mutations

## Post-Merge Smoke

Run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

## Follow-Up

- Decide whether to split the remaining directory-review code into a dedicated branch before opening a PR
- Resolve the existing backend workspace type-check blockers separately from this DingTalk change
- Re-authenticate Claude CLI only if you want it for later docs-only or backend review tasks
