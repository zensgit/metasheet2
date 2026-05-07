# K3 WISE Postdeploy URL Secret Guard Verification - 2026-05-07

## Commands

```bash
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --check scripts/ops/integration-k3wise-postdeploy-summary.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
git diff --check
```

## Result

- Postdeploy smoke + summary tests: 24/24 passed.
- `git diff --check`: passed.

## Coverage Added

- Reject base URLs with username/password material without echoing those values.
- Reject base URLs with query strings without echoing query values.
- Redact unsafe base URL material when rendering existing smoke evidence into summaries.

## Residual Risk

The smoke script now rejects all query parameters, including non-secret query parameters. That is intentional for this operator-facing deployment probe: the base URL should identify the app origin only, and API paths add their own query strings.

