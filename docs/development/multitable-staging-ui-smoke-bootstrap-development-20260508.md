# Multitable Staging UI Smoke Bootstrap - Development - 2026-05-08

## Context

The Multitable RC API/staging harness is green, but the browser-level RC
Playwright specs were still local-only:

- Frontend URL hard-coded to `http://127.0.0.1:8899`.
- Backend URL hard-coded to `http://localhost:7778`.
- Auth hard-coded to `phase0@test.local` / `Phase0Test!2026`.

On staging/142, the `phase0@test.local` account is not available, so those
tests skip or fail before exercising the UI. The goal of this slice is to make
the existing RC Playwright smokes runnable against staging using a short-lived
admin token, without creating accounts or changing product runtime code.

## Changes

### E2E helper bootstrap

Updated `packages/core-backend/tests/e2e/multitable-helpers.ts`:

- `FE_BASE_URL` now reads `process.env.FE_BASE_URL`, falling back to
  `http://127.0.0.1:8899`.
- `API_BASE_URL` now reads `process.env.API_BASE_URL`, falling back to
  `http://localhost:7778`.
- Base URLs strip trailing slashes so callers can pass either
  `http://host:port` or `http://host:port/`.
- `resolveE2EAuthToken(request)` now uses `AUTH_TOKEN` when present and falls
  back to `loginAsPhase0(request)` otherwise.
- `ensureServersReachable()` still checks `/health`, and now falls back to
  `/api/health` before skipping.
- `injectTokenAndGo()` now writes the current frontend auth keys:
  `auth_token`, `jwt`, and `devToken`.
- The previous smoke-only keys `metasheet_token` and `token` are still written
  for backwards compatibility.

### Spec wiring

Updated the six multitable RC Playwright specs to call
`resolveE2EAuthToken(request)` instead of `loginAsPhase0(request)` directly:

- `multitable-lifecycle-smoke.spec.ts`
- `multitable-public-form-smoke.spec.ts`
- `multitable-hierarchy-smoke.spec.ts`
- `multitable-gantt-smoke.spec.ts`
- `multitable-formula-smoke.spec.ts`
- `multitable-automation-send-email-smoke.spec.ts`

Local behavior is unchanged when `AUTH_TOKEN` is absent.

### Playwright config and docs

Updated `packages/core-backend/tests/e2e/playwright.config.ts`:

- `use.baseURL` now follows `FE_BASE_URL` when provided.

Updated `packages/core-backend/tests/e2e/README.md`:

- Documented `FE_BASE_URL`, `API_BASE_URL`, and `AUTH_TOKEN`.
- Added a staging/remote execution example using SSH tunnels.
- Clarified that `phase0@test.local` is the local fallback, not a staging
  prerequisite.

### Regression coverage

Added `packages/core-backend/tests/unit/multitable-e2e-helper-env.test.ts`:

- Defaults to local URLs when env is absent.
- Reads env URLs and strips trailing slashes.
- Uses `AUTH_TOKEN` before attempting phase0 login.
- Keeps injected browser storage keys aligned with the current frontend auth
  storage keys plus legacy smoke keys.

## Security Notes

- This change does not introduce any new token generation endpoint.
- Staging tokens remain operator-supplied via environment or file.
- The README examples use `AUTH_TOKEN="$(cat /tmp/...)"` and do not include any
  token literal.
- During verification, temporary token files were deleted after use.

## Non-Goals

- This slice does not fix product UI rendering behavior.
- This slice does not create staging users.
- This slice does not change the deployed staging image.
- This slice does not make `handoff-journey.spec.ts` remote-token aware; that
  spec still has a separate PLM/Yuantus setup model.
