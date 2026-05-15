# Data Factory issue #1542 package verification - 2026-05-15

## Local Verification

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
node --test scripts/ops/multitable-onprem-release-gate.test.mjs
rg -n 'integration-issue1542-seed-workbench-systems.mjs|data-factory-issue1542-install-smoke' \
  scripts/ops/multitable-onprem-package-build.sh \
  scripts/ops/multitable-onprem-package-verify.sh
rg -n --fixed-strings -- '--issue1542-install-staging' \
  scripts/ops/multitable-onprem-package-verify.sh \
  scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  docs/operations/integration-k3wise-internal-trial-runbook.md
git diff --check
synthetic on-prem zip verifier smoke
```

Results:

```text
bash -n scripts/ops/multitable-onprem-package-build.sh
PASS

bash -n scripts/ops/multitable-onprem-package-verify.sh
PASS

node --test scripts/ops/multitable-onprem-release-gate.test.mjs
PASS: 1/1

rg seed helper / install-smoke package allowlists
PASS

rg --issue1542-install-staging verifier contract
PASS

git diff --check
PASS

synthetic on-prem zip verifier smoke
PASS: `multitable-onprem-package-verify.sh` returned `Package verify OK`
against a generated zip containing the required issue #1542 package paths and
contract strings.
```

## Coverage

This verification proves:

- the package build allowlist copies
  `scripts/ops/integration-issue1542-seed-workbench-systems.mjs`;
- the package build allowlist copies issue #1542 postdeploy smoke,
  seed-helper, and install-staging development/verification notes;
- the package verifier requires `--issue1542-install-staging` in the packaged
  postdeploy smoke;
- the package verifier requires the K3 internal-trial runbook to document the
  install-staging retest flag;
- the package verifier's required-path list now matches the package build
  allowlist for the issue #1542 helper/docs.
- a synthetic package zip containing the required files satisfies the updated
  verifier, including the new install-staging fixed-string checks.

## Deferred Host Verification

This slice does not generate a new official Windows zip locally. After merge,
the recommended host-facing verification is:

```bash
gh workflow run multitable-onprem-package-build.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=data-factory-issue1542 \
  -f publish_release=false
```

Then download the artifact and run:

```bash
scripts/ops/multitable-onprem-package-verify.sh <downloaded-package.zip>
```

Expected result:

```text
Package verify OK
```

## Risk

The change is packaging-only. It does not modify application runtime behavior.
The remaining deployment truth still comes from applying the zip to the bridge
host and running the authenticated K3/Data Factory postdeploy smoke.
