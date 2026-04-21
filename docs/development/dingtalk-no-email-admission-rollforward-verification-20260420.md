# DingTalk No-Email Admission Rollforward Verification

Date: 2026-04-20
Branch: `codex/dingtalk-no-email-admission-20260420`

## Commands run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/AuthService.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  tests/unit/directory-sync-auto-admission.test.ts \
  --watch=false

pnpm --filter @metasheet/web exec vitest run \
  tests/LoginView.spec.ts \
  tests/userManagementView.spec.ts \
  tests/directoryManagementView.spec.ts \
  --watch=false

pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

- backend tests: `137 passed`
- frontend tests: `49 passed`
- backend build: passed
- web build: passed

## Verified behaviors

### Backend

- admin user creation accepts no-email users when username or mobile is provided
- directory manual admission accepts no-email users when username or mobile is provided
- directory auto-admission builds deterministic usernames for no-email users
- no-email onboarding skips invite issuance and returns temporary-password metadata
- auth login accepts generic identifiers
- username login works
- ambiguous mobile login is rejected safely

### Frontend

- login page uses a generic account identifier
- user management create-user flow supports no-email provisioning
- directory management manual-admission flow supports no-email create-and-bind
- directory management UI surfaces no-email auto-admission onboarding packets

## Non-blocking noise

- frontend Vitest printed `WebSocket server error: Port is already in use`
- web build still printed the existing chunk-size warning

Neither issue blocked the test or build result.

## Additional check

Claude Code CLI was invoked successfully in read-only mode during this rollforward:

```bash
claude -p "In one short sentence, describe the safest user-facing summary for enabling no-email DingTalk directory admission."
```

The CLI completed successfully and was used only for wording assistance, not for direct code generation.
