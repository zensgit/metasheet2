# DingTalk Directory Review GroupBy Fix Verification

Date: 2026-04-18

## Worktree

Validated in clean worktree:

- branch: `codex/dingtalk-sync-fix-20260418`

## Commands

Installed workspace dependencies in the clean worktree:

```bash
pnpm install --frozen-lockfile
```

Ran targeted backend verification:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/directory-sync-review-items.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  --watch=false

pnpm --filter @metasheet/core-backend build
```

## Results

- `tests/unit/directory-sync-review-items.test.ts` + `tests/unit/admin-directory-routes.test.ts`
  - `25 passed`
- `pnpm --filter @metasheet/core-backend build`
  - passed

## Verified Behavior

Confirmed that:

1. grouped review item SQL no longer references `l.local_user_id` inside
   `CASE` expressions;
2. grouped single-item review SQL no longer references `l.local_user_id`
   inside `CASE` expressions;
3. the admin directory routes still pass their existing route-level contract
   tests unchanged;
4. the backend still builds after the query fix.

## Deployment Status

No remote deployment was executed in this round.

The fix is validated locally and is ready to go through review / merge /
deployment.
