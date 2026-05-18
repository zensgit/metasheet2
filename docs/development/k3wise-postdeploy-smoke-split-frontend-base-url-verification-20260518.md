# K3 WISE Postdeploy Smoke Split Frontend Base URL Verification - 2026-05-18

## Summary

This change was verified with focused Node tests and syntax checks. The
coverage proves both paths:

- A backend/API-only base URL still fails frontend route checks with actionable
  `FRONTEND_ROUTE_NOT_FOUND` diagnostics.
- A split API URL plus frontend/nginx URL passes the public route checks.

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --check scripts/ops/integration-k3wise-postdeploy-env-check.mjs
git diff --check
```

## Expected Results

The local result is:

- `integration-k3wise-postdeploy-smoke.test.mjs`: 26/26 pass.
- `integration-k3wise-postdeploy-env-check.test.mjs`: 15/15 pass.
- `integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 pass.
- `node --check` for both scripts: pass.
- `git diff --check`: pass.

## Coverage Matrix

| Area | Evidence |
| --- | --- |
| Backward-compatible single URL | Existing public and authenticated smoke tests still use only `--base-url`. |
| Backend-only URL diagnostics | `postdeploy smoke diagnoses backend-only base URL when frontend routes return 404`. |
| Split API/frontend URL | `postdeploy smoke can split API and frontend base URLs`. |
| Generated command | `generated smoke command includes split frontend base URL when supplied`. |
| URL secret safety | Existing base URL secret tests plus new invalid frontend query test. |
| Workflow wiring | `integration-k3wise-postdeploy-workflow-contract.test.mjs` checks manual and deploy workflows include the frontend URL path. |
| Docs | Internal-trial and Windows on-prem docs now explain API base vs frontend/nginx base. |

## Issue #651 Mapping

Latest #651 feedback for package `06129c700`:

- Backend/auth/staging/pipeline smoke checks passed.
- Data Factory UI copy improved.
- `/integrations/k3-wise` and `/integrations/workbench` still returned 404.
- Smoke artifact suggested the base URL may be a backend/API port or an origin
  without SPA history fallback.

This patch does not claim the frontend host is configured correctly. It makes
the verification tool able to prove the difference:

- If the operator supplies the frontend/nginx origin, route checks hit that
  origin.
- If frontend routes still 404 there, the deployment has an nginx/history
  fallback problem rather than an API-base selection problem.

## Post-Merge Entity-Machine Retest

After this PR is merged and repackaged, run:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --frontend-base-url "${METASHEET_FRONTEND_BASE_URL:-$METASHEET_BASE_URL}" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id default \
  --require-auth \
  --issue1542-workbench-smoke \
  --issue1542-install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542
```

Interpretation:

- `baseUrl` in JSON/MD is the API/control-plane URL.
- `frontendBaseUrl` in JSON/MD is the frontend/nginx URL.
- If API checks pass and frontend checks fail, inspect nginx/front-door SPA
  fallback for `/integrations/* -> index.html`.
