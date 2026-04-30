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

For the current 142 internal trial deployment, use tenant scope `default`.
`METASHEET_TENANT_ID=default` is configured as a GitHub repository variable, so
the manual workflow can be run without filling `tenant_id`; use the input only
when intentionally testing another tenant.

Token resolution order:

1. `METASHEET_K3WISE_SMOKE_TOKEN` secret.
2. deploy-host fallback minting a temporary masked admin token inside the
   running backend container.

The manual workflow fails when `require_auth=true` and token resolution or
authenticated checks fail.

When token resolution fails, the workflow still runs the smoke script without a
bearer token so it can upload a failure evidence artifact. Treat that artifact
as a blocked signoff record, not as a passed smoke. The final workflow gate
still fails on the token resolver return code.

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

## 142 Internal Trial Evidence

Latest confirmed signoff run:

- Workflow: `K3 WISE Postdeploy Smoke`
- Run: `https://github.com/zensgit/metasheet2/actions/runs/25157307393`
- Tenant source: repository variable `METASHEET_TENANT_ID=default`
- Result: `signoff.internalTrial=pass`
- Summary: `10 pass / 0 skipped / 0 fail`
- Artifact: `integration-k3wise-postdeploy-smoke-25157307393-1`

The run proved the deployed 142 environment can mint a temporary masked admin
token from the deploy host, reach the K3 setup frontend route, validate the
integration plugin route contract, list the four tenant-scoped control-plane
collections, and validate staging descriptors.
