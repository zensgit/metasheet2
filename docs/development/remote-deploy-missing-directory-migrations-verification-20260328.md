# Remote Deploy Missing Directory Migrations Verification

## Verification

Validated in clean worktree `codex/deploy-missing-directory-migrations-20260328`.

Commands:

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/comments.api.test.ts --reporter=dot
```

## Expected Release Impact

- Kysely migration discovery on deploy images will again include the directory migration names already recorded in the remote database.
- Remote deploy should move past `failed to migrate` for `zzzz20260323120000_create_user_external_identities is missing`.

## Out of Scope

- This slice does not merge the larger untracked directory runtime feature set.
- This slice does not claim the full directory feature is release-ready; it only restores migration history parity needed for deploy safety.
