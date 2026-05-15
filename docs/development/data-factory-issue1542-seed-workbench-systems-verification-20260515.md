# Data Factory Issue #1542 Workbench Seed Helper - Verification

Date: 2026-05-15

## Test Matrix

| Area | Command | Expected |
| --- | --- | --- |
| Seed helper unit coverage | `pnpm verify:integration-issue1542:seed-workbench` | PASS: 5/5 |
| Existing postdeploy smoke regression | `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS: 20/20 |
| K3 offline PoC regression | `pnpm verify:integration-k3wise:poc` | PASS: preflight/evidence/fixture/mock chain |
| Syntax | `node --check scripts/ops/integration-issue1542-seed-workbench-systems.mjs` | PASS |
| Package verifier syntax | `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| Whitespace/conflict markers | `git diff --check origin/main...HEAD` | PASS |

## Unit Scenarios

`scripts/ops/integration-issue1542-seed-workbench-systems.test.mjs` covers:

1. Existing `standard_materials` sheet id creates:
   - `metasheet:staging` source with `standard_materials.sheetId`;
   - `erp:k3-wise-webapi` target with `autoSubmit=false`, `autoAudit=false`;
   - no `credentials` property in the K3 target payload.
2. `--install-staging` calls `POST /api/integration/staging/install` and uses
   the returned `sheetIds.standard_materials`.
3. `--install-staging` with empty `sheetIds` fails before any external-system
   writes and prints the metadata-only fallback command.
4. Missing sheet id without `--install-staging` fails before any network write.
5. JSON and Markdown artifacts are written with mode `0600` and do not contain
   bearer tokens or raw URL userinfo/query secrets.

## Manual 142 Retest Plan

After this PR is deployed on 142, use the same token mint path as the previous
internal-trial smoke, then run:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --project-id default \
  --install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/issue1542-seed
```

Expected result:

```text
Issue #1542 Data Factory seed: PASS
Mode: install-staging-and-seed
Staging source: metasheet_staging_default
K3 target: issue1542_k3wise_webapi_metadata_target
```

If the install route returns no `sheetIds.standard_materials`, use the
metadata-only fallback that was validated on 142:

```bash
node scripts/ops/integration-issue1542-seed-workbench-systems.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --project-id default \
  --standard-materials-sheet-id issue1542_metadata_standard_materials \
  --standard-materials-view-id issue1542_metadata_view \
  --standard-materials-open-link /multitable/issue1542_metadata_standard_materials/issue1542_metadata_view \
  --out-dir artifacts/integration-k3wise/internal-trial/issue1542-seed
```

This fallback is only for the #1542 schema and draft-pipeline-save smoke. It
does not prove real staging records can be read; fix multitable provisioning
before dry-run.

Then rerun:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://127.0.0.1:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --require-auth \
  --issue1542-workbench-smoke \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542
```

Expected issue #1542 checks:

- `issue1542-system-readiness`: PASS
- `issue1542-staging-source-schema`: PASS
- `issue1542-k3-material-schema`: PASS
- `issue1542-pipeline-save`: PASS

## Safety Checks

- The helper does not accept or persist K3 username/password/token values.
- `credentials` is omitted from the K3 target upsert payload, so existing
  stored credentials are not overwritten.
- The K3 target is marked `metadataOnly` and keeps `autoSubmit=false` and
  `autoAudit=false`.
- Artifacts are `0600` and redact token-shaped strings, URL userinfo, and
  secret query parameters.

## Deployment Impact

This is an opt-in operator tool plus docs/package verification. Runtime product
behavior is unchanged until an operator explicitly runs the script with an auth
token.
