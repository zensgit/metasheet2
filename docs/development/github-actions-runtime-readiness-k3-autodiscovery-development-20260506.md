# GitHub Actions Runtime Readiness K3 Tenant Auto-Discovery - Development

Date: 2026-05-06
Branch: `codex/k3wise-runtime-readiness-autodiscovery-20260506`

## Goal

Prevent the GitHub Actions runtime readiness checker from reporting a false K3 deploy-auth blocker when the repository intentionally uses singleton tenant auto-discovery.

## Problem

`resolve-k3wise-smoke-token.sh` and the K3 postdeploy workflows already support two tenant-scope paths:

- explicit repo/manual tenant scope through `METASHEET_TENANT_ID`;
- singleton integration tenant auto-discovery through `K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=true`.

`scripts/ops/github-actions-runtime-readiness.mjs` only accepted the explicit `METASHEET_TENANT_ID` variable. That made runtime readiness fail even when the deploy workflow could resolve the tenant safely through the supported auto-discovery path.

There was a second smaller issue: a present-but-empty `METASHEET_TENANT_ID` counted as configured because the old check only looked for the variable name.

## Implementation

Files changed:

- `scripts/ops/github-actions-runtime-readiness.mjs`
- `scripts/ops/github-actions-runtime-readiness.test.mjs`

Changes:

- K3 hard-gate required variable is now only `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH`.
- Tenant scope is evaluated as an either/or contract:
  - non-empty `METASHEET_TENANT_ID`; or
  - truthy `K3_WISE_TOKEN_AUTO_DISCOVER_TENANT`.
- Empty `METASHEET_TENANT_ID` no longer counts as configured.
- Text and Markdown renderers now include:
  - `tenant configured`
  - `tenant auto-discovery enabled`
  - missing tenant-scope alternatives when neither path is ready.

## Why This Is Safe During Customer Wait

This does not change the deploy workflow, token resolver, customer-facing K3 adapter, or live PoC behavior. It only aligns a readiness diagnostic with behavior that already exists in the workflow/token resolver path.

## Residual Risk

Auto-discovery is still fail-closed at runtime. The readiness checker only verifies that the operator explicitly enabled the auto-discovery path; the token resolver still performs the actual singleton tenant check on the deploy host.
