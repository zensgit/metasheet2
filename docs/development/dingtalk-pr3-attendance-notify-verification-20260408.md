# DingTalk PR3 Attendance Hardening and Notification Verification

Date: 2026-04-08
Branch: `codex/dingtalk-pr3-attendance-notify-20260408`
Scope: attendance sync hardening and DingTalk robot notification

## Commands run

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/notification-service-dingtalk.test.ts
pnpm --filter @metasheet/core-backend test:integration:attendance
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts tests/unit/auth-login-routes.test.ts
curl -i -s http://127.0.0.1:18900/api/auth/dingtalk/launch
```

## Results

### Syntax check

- `node --check plugins/plugin-attendance/index.cjs` passed

### Backend build

- `pnpm --filter @metasheet/core-backend build` passed

### Unit tests

- `tests/unit/notification-service-dingtalk.test.ts` passed
- Result: `3/3` tests passed

Covered cases:

- DingTalk notification sends markdown robot payloads
- DingTalk webhook signing appends `timestamp` and `sign`
- DingTalk notification does not retry non-retryable `HTTP 400` webhook failures

### Attendance integration regression

- `pnpm --filter @metasheet/core-backend test:integration:attendance` passed
- Result: `66/66` tests passed

This regression run was used to confirm that PR3 attendance changes did not break the existing attendance plugin flow while adding:

- DingTalk HTTP timeout
- retry and backoff
- process-local app token cache
- per-user partial failure handling
- failed run completion updates

### Auth whitelist regression

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts tests/unit/auth-login-routes.test.ts` passed
- Result: `12/12` tests passed

Covered cases:

- DingTalk launch route is exempt from the global JWT gate
- DingTalk callback route is exempt from the global JWT gate
- DingTalk launch still builds a redirect URL with preserved state
- DingTalk callback still exchanges the code into a local session token

### Staging canary verification

- Host: `142.171.239.56`
- Staging web: `http://142.171.239.56:8082`
- Staging backend health: `http://127.0.0.1:18900/health`
- Staging image tag: `e7ab53a9b445b1251805327967a9e5a993862305`

Observed result:

- `GET /api/auth/dingtalk/launch` returned `200 OK`
- Response payload included a DingTalk OAuth URL and generated `state`
- `GET /login/dingtalk/callback` returned `200 OK` from the staging web container
- This replaced the previous staging behavior where the same route returned `401 Missing Bearer token`

## Notes

- PR3 originally returned `401 Missing Bearer token` on staging because `/api/auth/dingtalk/launch` and `/api/auth/dingtalk/callback` were missing from the global JWT whitelist; this was corrected by `fix(dingtalk): whitelist oauth auth routes`
- Staging can now reach the launch step, but a real DingTalk login callback still requires the rotated `DINGTALK_CLIENT_SECRET`
- The DingTalk notification path was verified with mocked fetch-based tests rather than a real robot endpoint
