# Integration K3 WISE Postdeploy URL Secret Guard Refresh Verification - 2026-05-13

## Scope

Verification for the refreshed K3 WISE postdeploy smoke base URL guard.

## Results

| Command | Result | Notes |
| --- | --- | --- |
| `node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs` | PASS | Script syntax check passed. |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS | 15/15 tests passed, including new inline-credential and query/hash rejection regressions. |
| `node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS | 12/12 tests passed; workflow wiring and summary rendering stayed stable. |
| `git diff --check` | PASS | No whitespace errors. |

## Regression Assertions

New tests verify:

- `https://admin:<secret>@metasheet.example.test` exits 1.
- The inline password is absent from stdout and stderr.
- Error output contains the redacted URL username marker instead of the raw
  secret.
- `https://metasheet.example.test?token=<secret>#<secret>` exits 1.
- Query and hash secrets are absent from stdout and stderr.
- Query and hash output are URL-redacted before being serialized in the error
  details.

## Notes

- No customer K3 endpoint was contacted.
- The old #1370 branch remains a stale/conflicting implementation source; this
  refreshed slice is the current-main replacement.
