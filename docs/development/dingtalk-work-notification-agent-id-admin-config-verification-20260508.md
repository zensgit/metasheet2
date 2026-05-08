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

## Remaining Non-Blocking Notes

- A real DingTalk send cannot be fully proven by the no-recipient basic test. Use a recipient DingTalk user id or a controlled automation run for final live acceptance.
- The older private-file env helper remains available for env-only operations, but the preferred admin flow after this change is UI test plus UI save.
- This local verification did not deploy to 142 by itself. Deployment still requires publishing the new GHCR backend/web images and updating the 142 containers.
