# Multitable Staging UI Smoke Bootstrap - Verification - 2026-05-08

## Local Verification

### Install/link dependencies in isolated worktree

```bash
pnpm install --frozen-lockfile
```

Result:

- Completed successfully.
- Used existing pnpm store; no downloads were needed.

### Unit regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-e2e-helper-env.test.ts \
  --reporter=verbose
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

Covered:

- Default local URLs.
- Env URL override and trailing-slash normalization.
- `AUTH_TOKEN` precedence over phase0 login.
- Browser auth storage key list.

### Playwright discoverability

```bash
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  --list
```

Result:

```text
Total: 22 tests in 7 files
```

The six multitable RC files account for 18 tests. `handoff-journey.spec.ts`
remains separate because it depends on the PLM/Yuantus flow.

### TypeScript targeted check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --skipLibCheck \
  tests/e2e/multitable-helpers.ts \
  tests/e2e/playwright.config.ts \
  tests/unit/multitable-e2e-helper-env.test.ts
```

Result:

```text
exit 0
```

## Staging/142 Verification

### Setup

The tests were run from the local worktree against staging/142 through SSH
tunnels:

```bash
ssh -fN \
  -L 18081:127.0.0.1:8081 \
  -L 18990:127.0.0.1:8900 \
  <staging-142>
```

Health checks:

- Frontend tunnel: `http://127.0.0.1:18081/`
- Backend tunnel: `http://127.0.0.1:18990/api/health`

A short-lived staging admin token was generated from the running backend
container and read from a local temporary file. The token literal is not
recorded here.

### First remote run, before browser storage-key fix

Command shape:

```bash
FE_BASE_URL=http://127.0.0.1:18081 \
API_BASE_URL=http://127.0.0.1:18990 \
AUTH_TOKEN="$(cat /tmp/metasheet-staging-ui-smoke-admin.jwt)" \
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  multitable-lifecycle-smoke.spec.ts \
  multitable-public-form-smoke.spec.ts \
  multitable-hierarchy-smoke.spec.ts \
  multitable-gantt-smoke.spec.ts \
  multitable-formula-smoke.spec.ts \
  multitable-automation-send-email-smoke.spec.ts \
  --reporter=line
```

Result:

```text
11 passed
7 failed
```

Finding:

- Browser-rendering cases landed on the login page.
- Root cause: `injectTokenAndGo()` wrote `metasheet_token` / `token`, while the
  current frontend reads `auth_token` / `jwt` / `devToken`.

This finding directly drove the storage-key fix in this slice.

### Second remote run, after browser storage-key fix

Command shape:

```bash
FE_BASE_URL=http://127.0.0.1:18081 \
API_BASE_URL=http://127.0.0.1:18990 \
AUTH_TOKEN="$(cat /tmp/metasheet-staging-ui-smoke-admin.jwt)" \
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  multitable-lifecycle-smoke.spec.ts \
  multitable-public-form-smoke.spec.ts \
  multitable-hierarchy-smoke.spec.ts \
  multitable-gantt-smoke.spec.ts \
  multitable-formula-smoke.spec.ts \
  multitable-automation-send-email-smoke.spec.ts \
  --workers=1 \
  --reporter=line
```

Output was filtered to redact `Authorization: Bearer ...` if a failure printed
request headers.

Result:

```text
15 passed
3 failed
```

Passed surfaces after this bootstrap:

- Automation `send_email` save/execute path.
- Formula render smoke first case.
- Formula helper/envelope and sanitize regressions except one transient API
  socket failure noted below.
- Hierarchy render and cycle guards.
- Lifecycle render and autoNumber raw-write guard.
- Public form happy path, disabled-view guard, and rotated-token guard.

Remaining failures:

1. `multitable-formula-smoke.spec.ts` / `updates a formula expression via PATCH`
   failed once with `apiRequestContext.post: socket hang up` when creating a
   base. Backend container health was OK after the run and the container start
   timestamp did not change, so this is recorded as a staging transport /
   transient failure rather than an auth-bootstrap failure.
2. `multitable-gantt-smoke.spec.ts` / bar rendering failed because the browser
   rendered the sheet in grid mode. The page contained the expected task data
   but no `.meta-gantt__bar`.
3. `multitable-gantt-smoke.spec.ts` / dependency-arrow rendering failed for the
   same reason. The page contained the expected predecessor data in grid mode
   but no `.meta-gantt__dependency-arrow`.

Important positive signal:

- The login-page failure disappeared after the storage-key fix.
- This confirms `AUTH_TOKEN` plus `injectTokenAndGo()` now works against
  staging/142 for browser-level multitable smoke tests.

## Cleanup

- Local temporary admin token file was removed.
- SSH tunnels were closed.
- No staging user was created.

## Conclusion

The staging UI smoke bootstrap is working:

- Remote URLs can be supplied without code edits.
- Staging auth can use an operator-provided `AUTH_TOKEN`.
- Browser auth injection now matches current frontend storage keys.

This does not claim full UI RC sign-off. It converts the previous blocker
(`phase0` account required, login page under staging) into a usable staging
Playwright path and exposes the next real UI follow-up: Gantt deep-link/view
selection renders grid content instead of the Gantt component on 142.
