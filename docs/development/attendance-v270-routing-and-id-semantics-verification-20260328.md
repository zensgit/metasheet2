# Attendance v2.7.0 Routing and ID Semantics Verification

## What I verified

### Repo hygiene

- `git diff --check`
  - result: passed

### Frontend

- `pnpm --filter @metasheet/web exec vitest run tests/authRedirect.spec.ts tests/utils/api.test.ts --watch=false`
  - result: passed
  - verified:
    - root and login routes omit the redundant pre-login redirect query
    - real in-app routes still keep redirect preservation
    - unauthorized root-path API redirects now go to plain `/login`

- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - result: passed

### Backend

- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "returns 404 for valid-but-missing approval flow and rule set ids while keeping malformed ids at 400" --reporter=dot`
  - result: passed
  - verified:
    - missing approval-flow delete with a valid UUID returns `404`
    - malformed approval-flow ids still return `400`
    - missing rule-set update with a valid UUID returns `404`
    - malformed rule-set ids still return `400`

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
  - result: passed

## Validation intent

This slice verifies two narrow guarantees:

- the home-path login experience is less noisy without changing protected-route deep-link behavior
- the Attendance admin routes keep a clear contract distinction between invalid ids and missing resources
