# DingTalk Directory Stack Merge Checklist

## Merge Scope

This checklist is for the combined DingTalk directory stack PR that includes:

- review queue
- alert acknowledgement
- bulk bind / unbind handling
- bulk DingTalk grant and namespace admission operations
- schedule observation snapshot and UI card

## Pre-Merge

- Confirm only DingTalk directory stack files and supporting docs are included
- Reconfirm the backend workspace `tsc` failure note is presented as pre-existing
- Keep unrelated untracked items excluded:
  - `.claude/`
  - `apps/web/tests/sessionCenterView.spec.ts`

## Review Checklist

- Backend
  - review queue counts align with item classification
  - alert ack route returns stable payload and writes audit log
  - batch bind deduplicates by `accountId`
  - batch unbind can optionally disable DingTalk grant
  - bulk user management routes validate all user IDs before mutating
  - schedule snapshot handles disabled, missing cron, invalid cron, configured-only, manual-only, and auto-observed states
- Frontend
  - schedule card refreshes independently
  - default alert filter remains `pending`
  - review queue selection state does not leak across refreshes
  - quick bind search drafts stay isolated per account
  - user management bulk actions refresh the selected detail user

## Post-Merge Smoke

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

## Follow-Up

- Split runtime scheduler registration work from this observational PR if automatic execution is still not wired
- Re-authenticate Claude CLI only if you want later docs-only or backend-review assistance
- Keep any further DingTalk OAuth work in a separate branch from directory administration
