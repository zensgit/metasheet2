# K3 WISE On-Prem Package Refresh Development - 2026-05-11

## Purpose

Produce a Windows/on-prem deployment package that includes the simplified K3 WISE setup page merged in PR #1468.

This is an operations refresh, not a product-code change. The code changes already landed in main through:

- `d906a7436` - `feat(integration): simplify K3 WISE setup page`
- latest package source SHA: `158bd831eef5b6b43354bc40c79d85a6259d2b3d`

The package is based on the latest `main`, so it also includes post-#1468 mainline fixes.

## Workflow

Triggered GitHub Actions workflow:

- workflow: `Multitable On-Prem Package Build`
- run id: `25677648370`
- run URL: `https://github.com/zensgit/metasheet2/actions/runs/25677648370`
- branch/ref: `main`
- package tag: `k3wise-ui-20260511`
- publish release: `false`

Command:

```bash
gh workflow run multitable-onprem-package-build.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=k3wise-ui-20260511 \
  -f publish_release=false
```

## Output

Artifact:

- `multitable-onprem-package-25677648370-1`

Files:

- `metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.zip`
- `metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.tgz`
- `metasheet-multitable-onprem-v2.5.0-k3wise-ui-20260511.json`
- `SHA256SUMS`

Local download path used for verification:

```text
/tmp/ms2-onprem-25677648370/multitable-onprem-package-25677648370-1/
```

## Deployment Meaning

Use the new `k3wise-ui-20260511` zip for the next Windows/entity-machine installation test.

It supersedes earlier K3 WISE packages for UI testing because it includes:

- simplified K3 WISE setup page
- K3API authority-code token support
- packaged integration plugin backend
- core SQL migrations including `must_change_password`
- hardened `008_plugin_infrastructure.sql` compatibility guards

## Non-Goals

This refresh does not:

- publish a GitHub Release
- change backend code
- change migrations
- run against a real customer K3 WISE endpoint
- deploy to the customer's Windows server

The next live step is to deploy this package on the target machine and run post-deploy smoke.
