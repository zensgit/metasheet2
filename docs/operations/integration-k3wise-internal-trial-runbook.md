# K3 WISE Internal Trial Runbook

## Purpose

Use this runbook to sign off an internal K3 WISE integration trial environment
before customer GATE answers arrive or before a customer live PoC starts.

Public-only smoke is useful for reachability diagnostics, but it is not an
internal-trial signoff.

## Required Signoff Evidence

A signoff-ready K3 WISE postdeploy smoke must satisfy all of the following:

- `integration-k3wise-postdeploy-smoke.json` exists.
- `ok=true`.
- `authenticated=true`.
- `signoff.internalTrial=pass`.
- `summary.fail=0`.
- `auth-me` passed.
- `integration-route-contract` passed.
- all four control-plane list probes passed:
  - `integration-list-external-systems`
  - `integration-list-pipelines`
  - `integration-list-runs`
  - `integration-list-dead-letters`
- `staging-descriptor-contract` passed.

If the evidence says `signoff.internalTrial=blocked`, the environment is not
ready for internal trial signoff even when the diagnostic result is otherwise
green.

## GitHub Actions Path

For manual signoff, run `K3 WISE Postdeploy Smoke` with:

- `base_url`: deployed MetaSheet base URL.
- `require_auth`: `true` (default).
- `tenant_id`: target tenant, unless singleton tenant auto-discovery is
  explicitly safe.
- `auto_discover_tenant`: `true` only when the deployment has exactly one
  integration tenant scope.

Token resolution order:

1. `METASHEET_K3WISE_SMOKE_TOKEN` secret.
2. deploy-host fallback minting a temporary masked admin token inside the
   running backend container.

The manual workflow fails when `require_auth=true` and token resolution or
authenticated checks fail.

## CLI Path

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke
```

Then render the summary:

```bash
node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff
```

## Deployment Workflow

The automatic deploy workflow can be made a hard authenticated smoke gate by
setting:

```text
K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true
```

Keep it unset or `false` only when the deployment is still in diagnostic mode.
Diagnostic mode can prove the web/API surface is reachable, but cannot sign off
the internal K3 WISE trial.
