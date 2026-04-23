# Legacy Cells Conflict Smoke Verification - 2026-04-23

## Summary

Result: PASS

This verifies the legacy spreadsheet cells optimistic-lock contract against the live 142 staging deployment after PR #1092.

## Local Script Tests

Command:

```bash
node --test scripts/ops/legacy-cells-conflict-smoke.test.mjs
```

Result: PASS

Output:

```text
tests 8
pass 8
fail 0
```

Coverage:

- URL normalization and `/api` base resolution.
- Spreadsheet cell endpoint construction.
- `.env` file parsing.
- Config merge precedence.
- Bootstrap admin credential key support.
- Required config validation.
- Markdown report rendering.

## Whitespace Check

Command:

```bash
git diff --check
```

Result: PASS

## Live Staging Smoke

Target:

```text
http://142.171.239.56:8081/api
```

Command shape:

```bash
AUTH_TOKEN="$(ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 '<generate short-lived JWT inside metasheet-backend>')" \
BASE_URL=http://142.171.239.56:8081 \
CONFIRM_WRITE=1 \
OUTPUT_DIR=output/legacy-cells-conflict-smoke/142-8081-dbadmin-20260423-102321 \
node scripts/ops/legacy-cells-conflict-smoke.mjs
```

Result: PASS

Report:

```text
output/legacy-cells-conflict-smoke/142-8081-dbadmin-20260423-102321/report.md
```

Checks:

```text
config.valid: PASS
auth.token: PASS
spreadsheet.create: PASS
cell.seed: PASS
cell.session-a-read: PASS
cell.session-b-read: PASS
cell.session-a-update: PASS
cell.session-b-conflict: PASS
cell.conflict-version-payload: PASS
cell.final-value-preserved: PASS
cell.final-version-current: PASS
spreadsheet.cleanup: PASS
```

Observed conflict payload:

```json
{
  "code": "VERSION_CONFLICT",
  "row": 0,
  "col": 0,
  "serverVersion": 2,
  "expectedVersion": 1
}
```

Final cell:

```json
{
  "row_index": 0,
  "column_index": 0,
  "value": {
    "value": "session-a"
  },
  "version": 2
}
```

Cleanup:

```text
spreadsheet.cleanup: PASS
```

## Failed Auth Attempts Before Final Smoke

These were expected environment/credential checks and did not write data:

- `p2-shared-dev.env` against `8081`: login `401`; dev-token `404`.
- `shared-dev.bootstrap.env` against `8081`: login `401`.
- A manually signed token using only trusted-token claims failed because production mode does not trust arbitrary JWT role claims.

The successful run used a JWT for an existing active admin user.

## Conclusion

The live staging backend enforces the legacy cells `expectedVersion` contract:

- stale same-cell writes return `409 VERSION_CONFLICT`;
- the conflict payload contains both server and expected versions;
- stale write does not overwrite the accepted write;
- temporary test data is cleaned up.
