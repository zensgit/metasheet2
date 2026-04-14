# Public Form Baseline Verification

Date: `2026-04-14`

## Scope Verified

This verification covers the Week 3 public-form baseline:

- anonymous form-context loading with `publicToken`
- anonymous public form submission
- create-only anonymous semantics
- public route wiring
- public form page rendering and submit flow

## Commands Run

### Backend

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-record-form.api.test.ts
```

Result:

- `tsc --noEmit` passed
- integration file passed: `1` file, `18` tests

Notes:

- this integration command had to run outside the sandbox because Supertest needs to bind a local listener
- before the final pass, I had to update the test mock harness to cover current permission and formula-dependency queries

### Frontend

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/multitable-embed-route.spec.ts tests/multitable-phase4.spec.ts tests/public-multitable-form.spec.ts
pnpm --filter @metasheet/web build
```

Result:

- targeted Vitest passed: `3` files, `16` tests
- web build passed

Notes:

- Vitest prints a Vite websocket `EPERM` warning in this environment
- the warning did not fail the run and all targeted tests still passed

## Key Assertions Covered

Backend integration now covers:

- anonymous public form context loads successfully with a valid token
- anonymous public submission succeeds with a valid token
- expired public link is rejected
- public token cannot load an existing `recordId`
- public token cannot update an existing `recordId`

Frontend coverage now covers:

- public form route prop parsing
- client calls include `publicToken` for form-context and submit
- public form page loads, submits, and switches to success state

## Final Verification Status

Status: `passed`

Evidence summary:

- backend type-check passed
- backend integration file passed after sandbox escalation
- frontend targeted tests passed
- frontend production build passed

## Residual Risk

- no rate limiting or anti-abuse controls yet
- no admin UI for link issuance or rotation yet
- public-form configuration still depends on direct `view.config.publicForm` data
