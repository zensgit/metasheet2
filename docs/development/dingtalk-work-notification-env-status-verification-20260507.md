# DingTalk Work Notification Env Status Verification

Date: 2026-05-07

## Scope

This verification covers the DingTalk work-notification env readiness closeout:

- backend redaction-safe runtime status
- existing admin DingTalk access payload extension
- user management UI diagnostics
- CLI helper and env template
- env validation gate for missing Agent ID

## Files Changed

- `.env.example`
- `scripts/validate-env.sh`
- `scripts/ops/dingtalk-work-notification-env-status.mjs`
- `scripts/ops/dingtalk-work-notification-env-status.test.mjs`
- `packages/core-backend/src/integrations/dingtalk/client.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/tests/unit/dingtalk-work-notification.test.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-work-notification-env-status-design-20260507.md`
- `docs/development/dingtalk-work-notification-env-status-verification-20260507.md`

## Commands

```bash
node --check scripts/ops/dingtalk-work-notification-env-status.mjs
node --test scripts/ops/dingtalk-work-notification-env-status.test.mjs
```

Result: passed, 7 tests.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-work-notification.test.ts --watch=false
```

Result: passed, 4 tests.

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
```

Result: passed, 47 tests. Existing non-blocking test output remains:

- `WebSocket server error: Port is already in use`
- `Not implemented: navigation to another Document`

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed.

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Existing Vite warnings remain for chunk size and
`WorkflowDesigner.vue` dynamic/static import.

```bash
bash -n scripts/validate-env.sh
```

Result: passed.

```bash
DATABASE_URL=postgresql://localhost/metasheet \
JWT_SECRET=dev \
DINGTALK_APP_KEY=key \
DINGTALK_APP_SECRET=credential \
bash scripts/validate-env.sh development
```

Result: failed as expected with missing
`DINGTALK_AGENT_ID DINGTALK_NOTIFY_AGENT_ID`.

```bash
DATABASE_URL=postgresql://localhost/metasheet \
JWT_SECRET=dev \
DINGTALK_APP_KEY=key \
DINGTALK_APP_SECRET=credential \
DINGTALK_AGENT_ID=123 \
bash scripts/validate-env.sh development
```

Result: passed.

```bash
git diff --check -- .env.example scripts/validate-env.sh scripts/ops/dingtalk-work-notification-env-status.mjs scripts/ops/dingtalk-work-notification-env-status.test.mjs packages/core-backend/src/integrations/dingtalk/client.ts packages/core-backend/src/routes/admin-users.ts packages/core-backend/tests/unit/dingtalk-work-notification.test.ts apps/web/src/views/UserManagementView.vue apps/web/tests/userManagementView.spec.ts
```

Result: passed.

```bash
rg -n "SEC[A-Za-z0-9]{20,}|access_token=[0-9a-fA-F]{20,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" .env.example scripts/validate-env.sh scripts/ops/dingtalk-work-notification-env-status.mjs scripts/ops/dingtalk-work-notification-env-status.test.mjs packages/core-backend/src/integrations/dingtalk/client.ts packages/core-backend/src/routes/admin-users.ts packages/core-backend/tests/unit/dingtalk-work-notification.test.ts apps/web/src/views/UserManagementView.vue apps/web/tests/userManagementView.spec.ts
```

Result: no matches.

## Current Remaining Runtime Step

The helper was copied to 142 and run against `/home/mainuser/metasheet2/docker/app.env`
plus `/home/mainuser/metasheet2/.env`.

Result: `blocked`.

- App key family: present through `DINGTALK_CLIENT_ID`.
- App secret family: present through `DINGTALK_CLIENT_SECRET`.
- Agent id family: missing.

142 therefore still needs `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID` to
be set outside Git. After setting it and restarting backend, rerun this helper
on 142 and rerun the group failure-alert probe expecting `success`.
