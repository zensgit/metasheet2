# Multitable Feishu RC 142 API Smoke Verification - 2026-05-06

## Status

- Target: `http://142.171.239.56:8081`
- Result: PASS
- Checks: 11/11 passed
- Local artifact path: `output/multitable-feishu-rc-api-smoke/142-20260506-022139/`
- Real staging run: completed.

## Preflight

Health endpoint:

```bash
curl -fsS --max-time 10 http://142.171.239.56:8081/api/health
```

Result summary:

```json
{
  "status": "ok",
  "ok": true,
  "success": true,
  "plugins": 13,
  "pluginsSummary": {
    "total": 13,
    "active": 13,
    "failed": 0
  },
  "dbPool": {
    "total": 0,
    "idle": 0,
    "waiting": 0
  }
}
```

Local token file:

```text
/tmp/metasheet-142-main-admin-72h.jwt
```

Validation note:

- The token file existed locally.
- Its expiry was checked before execution.
- The token value was not printed or committed.

## Smoke Command

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)" \
API_BASE="http://142.171.239.56:8081" \
CONFIRM_WRITE=1 \
ALLOW_INSTALL=1 \
EXPECTED_COMMIT="aec377f80" \
OUTPUT_DIR="output/multitable-feishu-rc-api-smoke/142-$(date +%Y%m%d-%H%M%S)" \
node scripts/ops/multitable-feishu-rc-api-smoke.mjs
```

Result:

```text
exit 0
```

## Report Summary

```text
Overall: PASS
API base: http://142.171.239.56:8081
Run ID: rc-api-smoke-2026-05-06T09-21-39-912Z
Started at: 2026-05-06T09:21:39.916Z
Finished at: 2026-05-06T09:21:45.518Z
Expected commit: aec377f80
Total checks: 11
Failing checks: none
Skipped checks: none
```

Metadata:

```text
userHash: 4c6b9c45b29a
baseId: base_b29d7ffc-1f07-4102-93ce-101c38b188c8
sheetId: sheet_613cdb67f0e98fcbd88ce09c
templateId: project-tracker
```

## Check Results

- `api.health`: PASS, status `200`
- `auth.token-present`: PASS
- `api.auth.me`: PASS, status `200`
- `api.integration-staging.descriptors`: PASS, status `200`
- `api.templates.list`: PASS, status `200`
- `api.templates.install`: PASS, status `201`
- `api.fields.batch-types`: PASS
- `api.records.create`: PASS, status `200`
- `api.records.patch.expected-version`: PASS, status `200`
- `api.views.conditional-formatting`: PASS, status `201`
- `api.public-form.submit`: PASS, status `200`

## Remaining Manual Smoke

The API smoke does not replace browser checks. The remaining staging checklist should still cover:

- XLSX import/export UI.
- Formula editor.
- Filter builder.
- Gantt view.
- Hierarchy view.
- Visual conditional formatting after reload.
- Automation `send_email`.

