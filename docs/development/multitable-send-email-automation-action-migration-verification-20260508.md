# Send Email Automation Action Constraint Migration — Verification

Date: 2026-05-08
Branch: `codex/send-email-automation-action-migration-20260508`

## Scope

This verification covers the database CHECK constraint widening needed for `send_email` automation actions.

It does not claim that staging/142 is green. Staging still needs redeploy, migration execution, and a fresh `pnpm verify:multitable-rc:staging` run after this fix lands.

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/send-email-automation-action-migration.test.ts \
  tests/unit/automation-v1.test.ts \
  --reporter=dot
```

Result: passed.

Evidence:

- Test files: 2 passed
- Tests: 129 passed
- New migration test: 3 passed
- Existing automation V1 regression: 126 passed

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-provider.test.ts \
  tests/unit/migrations.rollback.test.ts \
  --reporter=dot
```

Result: passed.

Evidence:

- Test files: 2 passed
- Tests: 14 passed

```bash
git diff --check
```

Result: passed.

## Expected Staging Recheck

After merge and deployment:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-staging-admin.jwt)" \
API_BASE="http://142.171.239.56:8081" \
pnpm verify:multitable-rc:staging
```

Expected result: the `automation-email` check should progress past rule creation and no longer fail on `chk_automation_action_type`.
