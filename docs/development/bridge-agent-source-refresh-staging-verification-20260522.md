# Bridge Agent Source Refresh Staging Verification

Date: 2026-05-22

## Local Verification

Commands run from the isolated worktree:

```bash
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Expected local result:

| Command | Result |
| --- | --- |
| `node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs` | PASS |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 29/29 |
| `bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| `pnpm verify:integration-k3wise:poc` | PASS, 23 preflight + 51 evidence + 4 fixture + 4 mock WebAPI + 12 mock SQL tests, plus mock chain PASS |
| `pnpm -F plugin-integration-core test` | PASS |

The focused tests cover:

- `--bridge-source-refresh-smoke` with `--bridge-refresh-install-staging`;
- target install into `metasheet:multitable` for `plm_raw_items`;
- pipeline save for `material`, `bom`, and `bom_child`;
- live run requests for the three capped refresh pipelines;
- failure when the runner reads more rows than it writes.

## Package Verification

The package verifier was extended so the official Windows on-prem package must
carry the BA-M3 smoke and runbook contract.

Relevant checks:

| Package verifier check | Expected marker |
| --- | --- |
| postdeploy smoke flag | `--bridge-source-refresh-smoke` |
| staging install flag | `--bridge-refresh-install-staging` |
| Bridge adapter kind | `bridge:legacy-sql-readonly` |
| staging install check | `bridge-refresh-target-install` |
| material run check | `bridge-refresh-material-run` |
| runbook command | `--bridge-source-refresh-smoke` |
| BOM child check | `bridge-refresh-bom_child-run` |
| design doc | `BA-M3` and `plm_raw_items` |

The final verification matrix for the PR should include:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh \
  scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
```

Package build/verify was also exercised with a temporary local package after
installing dependencies from the local pnpm store:

```bash
OUTPUT_DIR=/tmp/ms2-bridge-source-refresh-package \
PACKAGE_TAG=bridge-source-refresh-smoke-test \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
  scripts/ops/multitable-onprem-package-build.sh

VERIFY_REPORT_JSON=/tmp/ms2-bridge-source-refresh-package/package-verify.zip.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-source-refresh-package/package-verify.zip.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-bridge-source-refresh-package/metasheet-multitable-onprem-v2.5.0-bridge-source-refresh-smoke-test.zip

VERIFY_REPORT_JSON=/tmp/ms2-bridge-source-refresh-package/package-verify.tgz.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-source-refresh-package/package-verify.tgz.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-bridge-source-refresh-package/metasheet-multitable-onprem-v2.5.0-bridge-source-refresh-smoke-test.tgz
```

Result: zip verify PASS and tgz verify PASS. The first package build attempt
without `BUILD_WEB=1 BUILD_BACKEND=1` failed because the isolated worktree did
not have `apps/web/dist`; the successful run rebuilt the frontend and backend
before packaging.

## Entity-Machine Verification

This PR does not pretend to run the customer Bridge Agent from the macOS
development host. The entity-machine operator must run the command below on the
MetaSheet on-prem host after deploying the package:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --frontend-base-url "${METASHEET_FRONTEND_BASE_URL:-$METASHEET_BASE_URL}" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --bridge-source-refresh-smoke \
  --bridge-refresh-install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-bridge-refresh
```

PASS criteria:

- `bridge-refresh-target-install` passes;
- `bridge-refresh-system-readiness` passes;
- each `bridge-refresh-<object>-pipeline-save` passes;
- each `bridge-refresh-<object>-run` passes;
- each run reports `rowsRead` between one and three;
- `rowsCleaned == rowsRead`;
- `rowsWritten == rowsCleaned`;
- `rowsFailed == 0`;
- no row values or secrets are pasted into GitHub.

FAIL criteria:

- Bridge source system cannot be found;
- staging target cannot be installed;
- any pipeline save fails;
- any run reads rows but writes fewer rows;
- any run reports failed rows;
- evidence contains token, credential, connection string, or raw row values.

## Secret Hygiene

This slice keeps evidence low-detail by construction. The JSON/Markdown
artifact should contain check names, ids, object names, and counts only. It
must not contain:

- authentication token values;
- Bridge shared secret values;
- SQL host, database, or user values;
- K3 WebAPI token or credential values;
- row payload values from `material`, `bom`, or `bom_child`.

## Deployment Impact

Runtime impact is opt-in only. Existing postdeploy smoke behavior is unchanged
unless the operator supplies `--bridge-source-refresh-smoke`.

The smoke writes MetaSheet staging rows into `plm_raw_items` when explicitly
requested. It does not call K3 WISE Save, Submit, or Audit, and it does not
alter the Bridge Agent SQL read contract.
