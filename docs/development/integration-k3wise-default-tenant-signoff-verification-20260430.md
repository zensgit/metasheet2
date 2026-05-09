# K3 WISE Default Tenant Signoff Verification

## Repository Variable

```bash
gh variable list --repo zensgit/metasheet2 --json name,updatedAt \
  | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const vars=JSON.parse(s); console.log(vars.filter(v=>v.name==="METASHEET_TENANT_ID"))})'
```

Observed:

```text
METASHEET_TENANT_ID 2026-04-30T09:11:56Z
```

The value is intentionally not a secret; it is `default`.

## Live Signoff Runs

### Explicit Tenant Probe

Workflow:

```bash
gh workflow run integration-k3wise-postdeploy-smoke.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f base_url='http://142.171.239.56:8081' \
  -f require_auth=true \
  -f tenant_id=default \
  -f auto_discover_tenant=false \
  -f timeout_ms=10000
```

Result:

- Run: `https://github.com/zensgit/metasheet2/actions/runs/25157225647`
- Status: `success`
- Evidence: `signoff.internalTrial=pass`
- Summary: `10 pass / 0 skipped / 0 fail`

### Repository Variable Probe

Workflow:

```bash
gh workflow run integration-k3wise-postdeploy-smoke.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f base_url='http://142.171.239.56:8081' \
  -f require_auth=true \
  -f auto_discover_tenant=false \
  -f timeout_ms=10000
```

Result:

- Run: `https://github.com/zensgit/metasheet2/actions/runs/25157307393`
- Status: `success`
- Artifact: `integration-k3wise-postdeploy-smoke-25157307393-1`
- Evidence: `ok=true`
- Evidence: `authenticated=true`
- Evidence: `signoff.internalTrial=pass`
- Evidence: `auth-me.tenantId=default`
- Summary: `10 pass / 0 skipped / 0 fail`

## Evidence Checks

The downloaded evidence JSON for run `25157307393` contains these passing
checks:

- `api-health`
- `integration-plugin-health`
- `k3-wise-frontend-route`
- `auth-me`
- `integration-route-contract`
- `integration-list-external-systems`
- `integration-list-pipelines`
- `integration-list-runs`
- `integration-list-dead-letters`
- `staging-descriptor-contract`

## Local Documentation Check

```bash
git diff --check
```

Expected: no whitespace errors.
