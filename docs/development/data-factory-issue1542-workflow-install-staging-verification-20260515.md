# Data Factory issue #1542 workflow install-staging verification - 2026-05-15

## Local Verification

Commands:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
git diff --check
```

Results:

```text
node --test scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs
13/13 PASS

node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
2/2 PASS

node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
22/22 PASS

git diff --check
PASS, no whitespace or conflict-marker findings
```

## New Coverage

### Env Check

- `--issue1542-install-staging` implies `--issue1542-workbench-smoke`.
- Generated smoke command includes both issue #1542 flags.
- Evidence records:
  - `issue1542WorkbenchSmoke=true`;
  - `issue1542InstallStaging=true`.
- Token values do not appear in stdout, stderr, JSON evidence, or Markdown
  evidence.
- Missing authenticated tenant scope fails before the smoke runs.

### Workflow Contract

The manual workflow contract test now requires:

- dispatch input `issue1542_install_staging`;
- pre-smoke/smoke env wiring for `ISSUE1542_INSTALL_STAGING`;
- shell append of:
  - `--issue1542-workbench-smoke`;
  - `--issue1542-install-staging`.

### Runbook

The K3 internal-trial runbook now documents the GitHub Actions input and the
auth + tenant requirements for the issue #1542 install-staging retest.

## Deferred Remote Verification

After this PR lands, use GitHub Actions:

1. open `K3 WISE Postdeploy Smoke`;
2. set `require_auth=true`;
3. set `tenant_id=default` or the target tenant;
4. set `issue1542_install_staging=true`;
5. run the workflow against the bridge/test base URL.

Expected issue #1542 checks in the smoke artifact:

- `issue1542-staging-install`
- `issue1542-system-readiness`
- `issue1542-staging-source-schema`
- `issue1542-k3-material-schema`
- `issue1542-pipeline-save`

This remains a deployment smoke. It does not prove SQL Server executor
availability or execute K3 Save-only writes.
