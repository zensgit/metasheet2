# Multitable Feishu RC Field Types UI Smoke Verification - 2026-05-07

## Scope

Verify the runner-only field-type smoke coverage added to `scripts/verify-multitable-live-smoke.mjs`.

## Local Static Checks

Run from `/private/tmp/ms2-rc-field-types-smoke-20260507`.

```bash
pnpm install --frozen-lockfile --ignore-scripts
node --check scripts/verify-multitable-live-smoke.mjs
node --test scripts/verify-multitable-live-smoke.test.mjs
git diff --check
```

Result:

- `pnpm install --frozen-lockfile --ignore-scripts`: pass
- `node --check scripts/verify-multitable-live-smoke.mjs`: pass
- `node --test scripts/verify-multitable-live-smoke.test.mjs`: `1/1` pass
- `git diff --check`: pass

## 142 Staging Smoke

### Attempt 1 - 8081 Main Entry

Command shape, with token redacted:

```bash
AUTH_TOKEN="<redacted>" \
API_BASE=http://142.171.239.56:8081 \
WEB_BASE=http://142.171.239.56:8081 \
OUTPUT_ROOT=output/playwright/multitable-feishu-rc-field-types-smoke/20260506-184147 \
ENSURE_PLAYWRIGHT=false \
HEADLESS=true \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

Result:

- Overall: blocked before runner start
- Failure: backend not reachable at `http://142.171.239.56:8081`
- Remote evidence: `metasheet-142` has no main app container exposing `8081`; `127.0.0.1:8081` returns connection refused from the host.

### Attempt 2 - 8082 Staging Entry

Because `8081` is not serving the main app, a short-lived staging admin JWT was generated inside the running `metasheet-staging-backend` container using its runtime `JWT_SECRET`. The token value was not printed or committed. `/api/auth/me` validated successfully against `8082`.

Command shape, with token redacted:

```bash
AUTH_TOKEN="<redacted>" \
API_BASE=http://142.171.239.56:8082 \
WEB_BASE=http://142.171.239.56:8082 \
OUTPUT_ROOT=output/playwright/multitable-feishu-rc-field-types-smoke/20260506-184949 \
ENSURE_PLAYWRIGHT=false \
HEADLESS=true \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

Result:

- Overall: fail due target deployment drift
- Total checks before failure: `45`
- Failing check: `Currency PilotFlow-1778118617117`
- Report JSON: `output/playwright/multitable-feishu-rc-field-types-smoke/20260506-184949/report.json`
- Report MD: `output/playwright/multitable-feishu-rc-field-types-smoke/20260506-184949/report.md`
- Remote backend image: `ghcr.io/zensgit/metasheet2-backend:62a75f9809-itemresults`
- Failure detail: `api.multitable.create-field` returned `400 VALIDATION_ERROR`; the target backend accepts only the legacy field type enum `string | number | boolean | date | formula | select | link | lookup | rollup | attachment` and rejects `currency`.

New check evidence:

- `api.field-types.value-normalization`: not reached because deployed 8082 backend predates MF2 field types.
- `ui.field-types.reload-replay`: not reached because deployed 8082 backend predates MF2 field types.

Cleanup evidence:

- Temporary fields created before the failure were deleted by the runner cleanup path.
- No field-type temporary fields were created on 8082 because the first `currency` create failed.

## Conclusion

The runner change is locally valid, but the final 142 staging smoke cannot be marked complete until a 142 target is running a backend build that includes MF2 field types.

Required next gate:

1. Deploy current `main` or a verified image containing MF2 field types to the selected 142 smoke target.
2. Re-run the same `pnpm verify:multitable-pilot:staging` command.
3. Mark the RC TODO item complete only after `api.field-types.value-normalization` and `ui.field-types.reload-replay` pass.

## TODO Linkage

This verification adds executable coverage for this RC TODO item, but does not close it until the staging target is upgraded and the smoke passes:

- `Smoke test field types: currency, percent, rating, url, email, phone, longText, multiSelect.`
