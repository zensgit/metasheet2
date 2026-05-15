# Data Factory issue #1542 install-staging smoke verification - 2026-05-15

## Local commands

```bash
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --check scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
pnpm verify:integration-k3wise:poc
git diff --check
```

## Results

```text
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
PASS

node --check scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
PASS

node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
22 tests passed

pnpm verify:integration-k3wise:poc
PASS: preflight tests, evidence tests, fixture contract, mock K3 WebAPI,
mock SQL executor, and the mock PoC demo all passed.

git diff --check
PASS
```

## New coverage

### Install-and-register happy path

Test:

```text
issue1542 install-staging smoke creates staging source before schema and pipeline checks
```

Assertions:

- the script calls `POST /api/integration/staging/install`;
- the request body contains only tenant/workspace scope;
- the install result resolves `tenant-smoke:integration-core`;
- the script upserts a `metasheet:staging` source system;
- if an older staging source already exists, the script uses the freshly
  installed source ID for schema discovery and draft pipeline save;
- the source system config contains `standard_materials.sheetId`;
- field details are copied into the staging source config;
- downstream #1542 checks pass:
  - `issue1542-system-readiness`;
  - `issue1542-staging-source-schema`;
  - `issue1542-pipeline-save`.

### Install failure path

Test:

```text
issue1542 install-staging smoke fails clearly when staging install fails
```

Assertions:

- the smoke exits non-zero;
- evidence contains `issue1542-staging-install=fail`;
- the error names `/api/integration/staging/install returned HTTP 500`;
- the script does not continue to `issue1542-pipeline-save`.

## Existing coverage preserved

The existing #1542 smoke tests still pass:

- schema discovery failure when staging source fields are empty;
- JSONB `22P02` pipeline-save regression;
- token redaction in stdout/stderr/JSON evidence.

## Deploy-box retest command

After deploying a package containing this change:

Prerequisite: the deployment has one saved or seeded `erp:k3-wise-webapi`
target for the same tenant scope. The install-staging smoke creates the
MetaSheet staging source only.

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --issue1542-workbench-smoke \
  --issue1542-install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542
```

Expected result:

```text
summary.fail = 0
signoff.internalTrial = pass
```

## Notes

`SQLSERVER_EXECUTOR_MISSING` remains a separate runtime deployment item. This
smoke proves the Data Factory staging-to-K3 metadata path can bootstrap itself
after deploy; it does not claim SQL Server direct-read readiness.
