# K3 WISE Workbench Deploy Readiness Development - 2026-05-13

## Scope

This slice proves that the latest `main` can produce a deployable multitable
on-prem package for the K3 WISE + generic integration workbench path.

It does not add runtime behavior. The work is a deployment readiness checkpoint:

- Trigger the official GitHub Actions on-prem package workflow.
- Download the generated package artifacts.
- Verify both Windows `.zip` and Linux `.tgz` packages locally.
- Generate the customer delivery bundle from the downloaded package metadata.
- Record the exact package, run id, and deployment interpretation.

## Current Deployable Package

GitHub Actions run:

- Run: `25782457823`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25782457823`
- Head SHA: `78ecad71dae02d5936691e1f2d3819f584dd2121`
- Package tag: `k3wise-workbench-78ecad7`
- Artifact name: `multitable-onprem-package-25782457823-1`

Generated package files:

- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.zip`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.tgz`
- `metasheet-multitable-onprem-v2.5.0-k3wise-workbench-78ecad7.json`
- `SHA256SUMS`

Download command:

```bash
gh run download 25782457823 \
  --repo zensgit/metasheet2 \
  -n multitable-onprem-package-25782457823-1 \
  -D output/playwright/ga/25782457823
```

## Windows Deployment Interpretation

The Windows package is the `.zip` artifact. It includes the PowerShell package
apply helper:

- `scripts/ops/multitable-onprem-apply-package.ps1`

It also includes the K3 WISE operator tooling:

- `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/fixtures/integration-k3wise/*`

This means the package is suitable for a Windows Server on-prem test host,
provided the host has the documented runtime prerequisites. The package is not a
fully offline binary installer and does not intentionally vendor `node_modules`;
deployment scripts still need the runtime/dependency install path described in
the on-prem runbook.

## Product Readiness Boundary

This package supports deployment testing now:

- app login / runtime boot
- Workbench and K3 WISE setup page access
- mock/offline K3 PoC
- K3 preflight
- postdeploy smoke
- Save-only live PoC once customer GATE credentials and field answers are ready

It does not remove the customer GATE requirement for a real K3 WISE write. Live
Submit/Audit remains blocked until explicitly enabled after customer validation.

## Files

- `docs/development/k3wise-workbench-deploy-readiness-development-20260513.md`
- `docs/development/k3wise-workbench-deploy-readiness-verification-20260513.md`

## Non-Goals

- No source code change.
- No migration change.
- No customer K3 endpoint call.
- No GitHub Release publication.
