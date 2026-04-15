# DingTalk Directory Stack Merge Runbook

## Scope

This runbook is the final operator-facing handoff for PR [#873](https://github.com/zensgit/metasheet2/pull/873).

Covered scope:

- directory review queue
- recent alert acknowledgement
- batch bind / unbind handling
- bulk DingTalk grant and namespace admission
- schedule observation card

Not covered:

- runtime scheduler wiring
- DingTalk OAuth callback changes
- unrelated backend type-fix cleanup

## Merge Preconditions

Before merge:

1. Re-read the scope clarification comment on `#873`:
   - <https://github.com/zensgit/metasheet2/pull/873#issuecomment-4245309186>
2. Treat the PR as a focused DingTalk admin/ops slice, not as the full Feishu-gap program.
3. Keep the backend workspace `tsc --noEmit` caveat framed as pre-existing.
4. Review batch operations as per-item mutations, not cross-item transactional rollback.
5. Review the schedule card as an observation layer, not proof of scheduler wiring.

## Review Focus

- `admin-directory` routes:
  - review queue counts
  - alert acknowledgement payload
  - batch bind / batch unbind semantics
- `admin-users` routes:
  - bulk DingTalk grant mutation
  - bulk namespace admission mutation
- frontend:
  - review queue state isolation
  - alert filter defaulting to `pending`
  - schedule observation copy and caution banner

## Merge Steps

1. Confirm `#873` still targets `main`.
2. Confirm the PR branch `codex/feishu-gap-rc-integration-202605` contains the latest comment-posting and review-followup docs.
3. Confirm no unrelated files are included.
4. Merge with a normal PR merge; do not squash unrelated history into this PR from other branches.

## Post-Merge Smoke

Run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Then manually confirm:

- review queue loads with counts
- alert acknowledgement changes state from pending to acknowledged
- batch bind and batch unbind still refresh affected rows
- schedule card shows caution copy unless `auto_observed`

## Rollback Shape

If rollback is required, revert the PR commits as a unit rather than trying to partially remove only one of the admin surfaces. The queue, alert panel, batch actions, and schedule observation were shipped as one operational slice and should be rolled back together unless a narrower revert is clearly isolated.
