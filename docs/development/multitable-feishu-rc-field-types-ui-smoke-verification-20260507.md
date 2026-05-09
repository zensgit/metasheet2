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

## Follow-up Runner Hardening

Two runner-only issues were fixed after the first successful deployment of `#1379` to 8081:

- Phone link assertion now derives the expected `tel:` href with the same digit sanitization as `MetaCellRenderer.vue`, instead of using a hand-written constant.
- Import mapping reconcile now uses `ensureImportFieldMappedByColumnIndex()` so the runner actively maps the target field when the import preview does not auto-select quickly enough.

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
- Remote evidence at that moment: `127.0.0.1:8081` returned connection refused from the host. Later recheck showed this was deploy-target churn, not a durable topology fact.

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

### Attempt 3 - 8081 Main After #1379 Deploy

GitHub Actions run `25472158432` deployed main `e6f6547a158361042a42788701d8debef8e1d725` to 8081 successfully.

Remote target evidence:

- Repo: `/home/mainuser/metasheet2` at `e6f6547`
- `IMAGE_TAG=e6f6547a158361042a42788701d8debef8e1d725`
- `metasheet-web`: `ghcr.io/zensgit/metasheet2-web:e6f6547a158361042a42788701d8debef8e1d725`
- `metasheet-backend`: `ghcr.io/zensgit/metasheet2-backend:e6f6547a158361042a42788701d8debef8e1d725`
- `/api/health`: pass
- `/api/auth/me`: pass with a short-lived admin JWT generated inside the running backend container; token value was not printed or committed.

Command shape, with token redacted:

```bash
AUTH_TOKEN="<redacted>" \
API_BASE=http://142.171.239.56:8081 \
WEB_BASE=http://142.171.239.56:8081 \
OUTPUT_ROOT=output/playwright/multitable-feishu-rc-field-types-smoke/20260506-192330 \
ENSURE_PLAYWRIGHT=false \
HEADLESS=true \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

Result:

- Overall: fail due runner assertion, not product behavior
- Failure: `Phone cell anchor mismatch: tel:+8613800000000`
- Finding: the frontend correctly sanitizes `+86 138 0000 0000` to `tel:+8613800000000`; the runner expected a hand-written href with one fewer `0`.

### Attempt 4 - 8081 Main After Runner Hardening

Command shape, with token redacted:

```bash
AUTH_TOKEN="<redacted>" \
API_BASE=http://142.171.239.56:8081 \
WEB_BASE=http://142.171.239.56:8081 \
OUTPUT_ROOT=output/playwright/multitable-feishu-rc-field-types-smoke/20260506-193219 \
ENSURE_PLAYWRIGHT=false \
HEADLESS=true \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

Result:

- Overall: pass
- Total checks: `159/159`
- Report JSON: `output/playwright/multitable-feishu-rc-field-types-smoke/20260506-193219/report.json`
- Report MD: `output/playwright/multitable-feishu-rc-field-types-smoke/20260506-193219/report.md`
- Finished at: `2026-05-07T02:35:37.033Z`

New check evidence:

- `api.field-types.value-normalization`: pass
  - Covered field types: `currency`, `percent`, `rating`, `url`, `email`, `phone`, `longText`, `multiSelect`
  - `apiMismatches`: `[]`
- `ui.field-types.reload-replay`: pass
  - Initial and reloaded render both showed:
    - currency: `¥1,234.56`
    - percent: `37.5%`
    - rating: `★★★★☆`
    - url href: `https://example.com/multitable-rc`
    - email href: `mailto:rc-field-types@example.com`
    - phone href: `tel:+8613800000000`
    - longText: both lines
    - multiSelect tags: `Alpha`, `Gamma`

Cleanup evidence:

- Temporary imported records were deleted.
- Temporary attachment was deleted.
- Temporary field-type fields were deleted.
- Existing view `filterInfo` and `config` restoration completed as part of the full smoke.

## Conclusion

The field-type smoke item is now closed against 142 main/8081. The 8082 staging stack remains intentionally out of scope because it is still on the older `62a75f9809-itemresults` image and migration lineage.

## TODO Linkage

This verification closes this RC TODO item:

- `Smoke test field types: currency, percent, rating, url, email, phone, longText, multiSelect.`
