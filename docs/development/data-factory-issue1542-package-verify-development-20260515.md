# Data Factory issue #1542 package verification development - 2026-05-15

## Summary

This slice closes the packaging gap after the Data Factory #1542 postdeploy
smoke gained the opt-in `--issue1542-install-staging` path.

The package verifier already expected the issue #1542 seed helper to exist in
the on-prem package, but the package build allowlist did not copy that helper
into the archive. A generated Windows zip could therefore miss the helper that
the verifier and runbook rely on.

## Changes

- `scripts/ops/multitable-onprem-package-build.sh`
  - packages `scripts/ops/integration-issue1542-seed-workbench-systems.mjs`;
  - packages the issue #1542 postdeploy smoke, seed-helper, and install-staging
    development/verification notes.
- `scripts/ops/multitable-onprem-package-verify.sh`
  - requires `--issue1542-install-staging` in the packaged postdeploy smoke;
  - requires the K3 internal-trial runbook to document
    `--issue1542-install-staging`;
  - requires the issue #1542 development/verification docs to be present in the
    package.

## Operator Impact

After the next package build, the Windows/on-prem zip includes the complete
issue #1542 deployment retest chain:

1. K3/Data Factory postdeploy smoke.
2. Optional issue #1542 staging install flag.
3. Metadata-only seed helper for isolated smoke environments.
4. Runbook instructions explaining when to use each path.
5. Development and verification notes for auditability.

No runtime code path changes in the backend, frontend, adapters, migrations, or
plugins are introduced by this slice.

## Safety

- Packaging allowlists only.
- No credentials, K3 session tokens, SQL connection strings, or bearer tokens
  are added.
- No deployment script starts a pipeline, dry-run, Save-only, Submit, or Audit.
- The smoke remains opt-in for issue #1542 workbench retests.

## Follow-Up

Run the official `multitable-onprem-package-build.yml` workflow after merge and
download the resulting Windows zip. The package verifier should now prove that
the issue #1542 seed helper, install-staging smoke flag, and docs are all in the
archive.
