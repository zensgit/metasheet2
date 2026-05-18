# K3 WISE Postdeploy Smoke Frontend Base URL Diagnostic Verification - 2026-05-18

## Scope

Verifies the #651 diagnostic improvement for the case where backend/API smoke
checks pass but frontend SPA routes return 404.

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
git diff --check
```

## Results

| Command | Result |
| --- | --- |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 25/25 |
| `node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs` | PASS |
| `git diff --check` | PASS |

## New Coverage

Added `postdeploy smoke diagnoses backend-only base URL when frontend routes
return 404`.

The test creates a fake deployment that:

- returns 200 for `/api/health`;
- returns 200 for `/api/integration/health`;
- returns 404 for `/integrations/k3-wise`;
- returns 404 for `/integrations/workbench`.

Expected evidence:

- `api-health`: `pass`
- `k3-wise-frontend-route`: `fail`
- `data-factory-frontend-route`: `fail`
- both route checks include `code: FRONTEND_ROUTE_NOT_FOUND`
- both route checks include a frontend/nginx base URL hint
- Markdown evidence includes the diagnostic code and hint

## Compatibility Check

The existing Markdown escaping test remains green. This confirms the new
diagnostic fields do not regress the old single-error table detail format.

