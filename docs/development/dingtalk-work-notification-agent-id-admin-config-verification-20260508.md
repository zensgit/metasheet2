# DingTalk Work Notification Agent ID Admin Config Verification (2026-05-08)

## Scope Verified

- Admin UI can test and save DingTalk work-notification Agent ID.
- Backend stores Agent ID encrypted in `directory_integrations.config.workNotificationAgentId`.
- Runtime config can use env-only, DB-only, or mixed env plus DB settings.
- Automation delivery uses runtime config instead of env-only Agent ID.
- Release gate can pass when backend runtime is ready from stored config even if the env helper still reports missing Agent ID.
- API responses, audit metadata, and docs do not expose raw credential values.

## Local Validation

Backend DingTalk runtime and admin routes:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-work-notification.test.ts tests/unit/dingtalk-work-notification-settings.test.ts tests/unit/admin-directory-routes.test.ts --watch=false
```

Result: passed, 3 test files and 35 tests.

Automation regression plus runtime fallback:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-work-notification-settings.test.ts tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 2 test files and 148 tests.

Frontend directory management page:

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
```

Result: passed, 1 test file and 38 tests. The run emitted a non-blocking local WebSocket port-in-use warning, but the test suite completed successfully.

Release gate:

```bash
node --test scripts/ops/dingtalk-work-notification-release-gate.test.mjs
```

Result: passed, 5 tests.

Backend build:

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

Backend TypeScript check:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed.

Frontend build:

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Existing Vite chunk and dynamic-import warnings remained warnings only.

Backend package `type-check` script:

```bash
pnpm --filter @metasheet/core-backend type-check
```

Result: not run as a gate because this package has no `type-check` script. The replacement gate was `pnpm --filter @metasheet/core-backend exec tsc --noEmit`.

## Behavior Checks Covered By Tests

- Invalid Agent ID format is rejected before persistence.
- Saved Agent ID is encrypted and not printed in response payloads.
- Existing env-complete deployments do not query DB for work-notification runtime config.
- Env app key/app secret can combine with DB-stored Agent ID.
- Directory integration updates preserve existing stored Agent ID.
- Generic directory integration create/update payloads cannot write or override Agent ID.
- The frontend create-integration state hides the Agent ID input and dedicated buttons until an integration is selected.
- Admin route test/save responses and audit events are redaction-safe.
- Frontend test/save buttons call the dedicated Agent ID endpoints.
- Release gate accepts backend runtime readiness from stored config as an override for env-helper missing-Agent-ID status.

## 142 Verification To Run After Deployment

1. Confirm new backend and web images are deployed.
2. Visit the admin DingTalk directory management page.
3. Select the active DingTalk integration.
4. Fill the real Agent ID from the same DingTalk internal app as the configured app key/app secret.
5. Click "测试工作通知" without a recipient and verify the basic check passes.
6. Fill a real DingTalk user id, click "测试工作通知", and verify the recipient receives the work notification.
7. Click "保存 Agent ID" and refresh the page.
8. Verify the status chip shows `Agent ID 已保存` and the raw value is not shown.
9. Rerun the release gate and verify status is `pass`.
10. Trigger a controlled group robot failure and verify the rule creator receives the default work-notification failure alert.

## 142 Deployment Verification

Deployment was completed from GHCR immutable tag:

```text
9129dae6678e623ff1df2e0d0121d5882199e9ef
```

GitHub Actions:

- Workflow: `Build and Push Docker Images`
- Run: `25531740871`
- Result: build passed.
- Deploy job: skipped by workflow rule because this was a `codex/` branch dispatch, not `main`.
- Annotation: GitHub reported the Node.js 20 action runtime deprecation warning for `actions/checkout@v4` and `docker/login-action@v3`; this did not block the build.

142 baseline before deployment:

```text
backend image: ghcr.io/zensgit/metasheet2-backend:8f5bd7f4bbac3a2fe6298b3293f476628e224065
web image:     ghcr.io/zensgit/metasheet2-web:8f5bd7f4bbac3a2fe6298b3293f476628e224065
health:        /api/health success=true
```

142 deployment actions:

```text
backup:  /home/mainuser/metasheet2/.env.bak.before-9129dae66-20260508T014051Z
changed: IMAGE_TAG=9129dae6678e623ff1df2e0d0121d5882199e9ef
scope:   backend and web only
db:      migration command executed after backend/web recreation
```

142 post-deployment verification:

```text
backend image: ghcr.io/zensgit/metasheet2-backend:9129dae6678e623ff1df2e0d0121d5882199e9ef
web image:     ghcr.io/zensgit/metasheet2-web:9129dae6678e623ff1df2e0d0121d5882199e9ef
backend state: running
web state:     running
/api/health:   200, success=true, plugins=13, failed plugins=0
frontend:      200 from server-local http://127.0.0.1:8081/
/api/auth/me:  success=true, role=admin
```

New Agent ID admin endpoint on 142:

```text
GET /api/admin/directory/dingtalk/work-notification
ok=true
configured=false
available=false
source=mixed
unavailableReason=missing_agent_id
agentIdConfigured=false
```

Interpretation: the new backend route and frontend assets are deployed. Work notification is still blocked only because the real DingTalk Agent ID has not yet been saved in the admin UI or env.

Observed network note:

- Server-local frontend/API checks passed.
- A local-machine curl to the public `http://142.171.239.56:8081` returned an empty reply during this run. This has appeared in prior 142 verification notes and should be treated as a host/network edge until browser/mobile access is rechecked.

Rollback command if needed:

```bash
cd /home/mainuser/metasheet2
cp .env.bak.before-9129dae66-20260508T014051Z .env
docker compose -f docker-compose.app.yml pull backend web
docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend web
curl -fsS http://127.0.0.1:8900/api/health
```

## Remaining Non-Blocking Notes

- A real DingTalk send cannot be fully proven by the no-recipient basic test. Use a recipient DingTalk user id or a controlled automation run for final live acceptance.
- The older private-file env helper remains available for env-only operations, but the preferred admin flow after this change is UI test plus UI save.
- The 142 deployment is complete, but final DingTalk acceptance still requires saving the real Agent ID and running one real recipient work-notification test.
