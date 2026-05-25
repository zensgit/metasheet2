# K3 WISE business success evidence verification - 2026-05-25

## Local Verification

All commands were run from `/tmp/ms2-k3-business-success`.

```bash
node --check plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
node --check plugins/plugin-integration-core/lib/pipeline-runner.cjs
node --check plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
node --check plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
```

Result: all syntax checks passed.

```bash
pnpm --dir plugins/plugin-integration-core test:k3-wise-adapters
```

Result:

```text
✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
```

```bash
pnpm --dir plugins/plugin-integration-core test:pipeline-runner
```

Result:

```text
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
```

## Regression Cases Added

### K3 Save row-level failure is not written

Added adapter coverage for a K3 response with:

```json
{
  "StatusCode": 200,
  "Message": "Successful",
  "Data": [
    {
      "FStatus": false,
      "FItemID": 0,
      "FMessage": "unit group parameter invalid"
    }
  ]
}
```

Expected result:

- `written=0` for that row;
- `failed=1`;
- error code remains `K3_WISE_SAVE_FAILED`;
- response summary reports `success=false` and `failedRowCount=1`.

### K3 `StatusCode=201` + `Message=Faild` is not written

Added adapter coverage for the observed K3 failure spelling:

```json
{
  "StatusCode": 201,
  "Message": "Faild",
  "Data": [
    {
      "FStatus": false,
      "FItemID": 0,
      "FMessage": "required unit missing"
    }
  ]
}
```

Expected result:

- not counted as written;
- failure is surfaced through the target error path;
- business summary reports `success=false`.

### K3 Save requires stronger evidence than envelope 200

Added internal assertions:

- generic `businessSuccess()` rejects explicit row-level failure;
- `saveBusinessSuccess({ StatusCode: 200, Message: "Successful" })` returns
  false;
- `saveBusinessSuccess()` returns true only when a row has `FStatus=true` and a
  meaningful id.

### Run details persist sanitized response summaries

Added pipeline-runner coverage proving adapter `metadata.businessResponses[]`
is persisted to run details as `targetWriteSummaries[]` after payload
sanitization.

The test intentionally injects a fake `token` key into the adapter summary and
asserts the stored run detail contains:

```text
token = [redacted]
```

## Deployment Impact

- No migration.
- No config change.
- No frontend change.
- Existing Save failure code stays compatible as `K3_WISE_SAVE_FAILED`.
- Runs that previously treated K3 outer envelope success as a write may now
  correctly become `partial` / failed when K3 row-level business status is
  negative.

## Remaining Work

This PR intentionally does not solve the complete K3 Material reference-field
write shape. Follow-up work should add a customer-confirmed full Material Save
template and reference-resolution mapping for fields such as unit group, units,
accounts, stock, and valuation defaults.

Post-save readback should also be added as a separate optional evidence gate
after the Save response parser is fixed.
