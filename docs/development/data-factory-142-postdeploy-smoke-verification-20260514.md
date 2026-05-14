# Data Factory 142 Postdeploy Smoke Verification - 2026-05-14

## Scope

This verification records the post-merge 142 deployment smoke for
`main@e8eb9b212`, after PR #1525 added the Data Factory frontend route check to
the existing K3 WISE postdeploy smoke.

## Main Workflow Gates

Command:

```bash
gh run watch 25839972397 --repo zensgit/metasheet2 --exit-status
```

Result:

- `Plugin System Tests` passed on `main@e8eb9b212`.
- `K3 WISE offline PoC` passed.
- `DingTalk P4 ops regression gate` passed.
- `test (18.x)` passed.
- `test (20.x)` passed.
- `after-sales integration` passed.

Additional main workflows observed for `main@e8eb9b212`:

- `Phase 5 Production Flags Guard`: success.
- `Deploy to Production`: success.
- `Build and Push Docker Images`: success.
- `.github/workflows/monitoring-alert.yml`: success.

Deploy-readiness command:

```bash
pnpm verify:integration-erp-plm:deploy-readiness
```

Result:

- `ERP/PLM deploy readiness: PASS`.
- Head SHA: `e8eb9b212f39bd10ef1e16c3a8a61271012a0977`.
- Internal deployment: `ready-for-physical-machine-test`.
- Customer live remains `blocked-until-customer-gate-and-test-account`.
- Missing customer GATE fields: `tenantId`, `workspaceId`, `k3Wise`, `plm`,
  `rollback`.

## Local Connectivity Probe

Commands:

```bash
curl -fsS --max-time 8 http://142.171.239.56:8081/api/health
curl -fsS --max-time 8 http://142.171.239.56:8081/integrations/workbench
ssh -o BatchMode=yes -o ConnectTimeout=5 mainuser@142.171.239.56 'cd /home/mainuser/metasheet2 && git rev-parse --short HEAD'
```

Result:

- Public HTTP returned `curl: (52) Empty reply from server`.
- SSH returned `Permission denied (publickey,password)`.
- Local workstation access was therefore not used as deployment signoff.

## GitHub Postdeploy Smoke

Command:

```bash
gh workflow run integration-k3wise-postdeploy-smoke.yml \
  --repo zensgit/metasheet2 \
  --ref main \
  -f base_url=http://142.171.239.56:8081 \
  -f require_auth=true \
  -f tenant_id=default \
  -f auto_discover_tenant=false \
  -f timeout_ms=10000
```

Workflow run:

- URL: `https://github.com/zensgit/metasheet2/actions/runs/25840155752`
- Status: success.
- Artifact: `integration-k3wise-postdeploy-smoke-25840155752-1`.

Downloaded artifact command:

```bash
gh run download 25840155752 \
  --repo zensgit/metasheet2 \
  --dir /tmp/ms2-k3wise-postdeploy-25840155752
```

## Artifact Summary

From
`integration-k3wise-postdeploy-smoke/manual/integration-k3wise-postdeploy-smoke.json`:

```json
{
  "ok": true,
  "authenticated": true,
  "signoff": {
    "internalTrial": "pass",
    "reason": "authenticated smoke passed"
  },
  "summary": {
    "pass": 11,
    "skipped": 0,
    "fail": 0
  }
}
```

Passing checks:

- `api-health`
- `integration-plugin-health`
- `k3-wise-frontend-route`
- `data-factory-frontend-route`
- `auth-me`
- `integration-route-contract`
- `integration-list-external-systems`
- `integration-list-pipelines`
- `integration-list-runs`
- `integration-list-dead-letters`
- `staging-descriptor-contract`

From
`integration-k3wise-postdeploy-env-check/manual/integration-k3wise-postdeploy-env-check.json`:

- `ok=true`
- `summary.pass=5`
- `summary.warn=0`
- `summary.fail=0`

Passing input checks:

- `base-url`
- `auth-token`
- `tenant-id`
- `smoke-output`
- `timeout`

## Artifact Secret Scan

Command:

```bash
artifact=/tmp/ms2-k3wise-postdeploy-25840155752/integration-k3wise-postdeploy-smoke-25840155752-1
rg -n --pcre2 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "$artifact"
rg -n --pcre2 'Bearer\s+[A-Za-z0-9._-]+' "$artifact"
rg -n --pcre2 '(access_token|token|password|secret|sign|signature|api_key|session_id|auth)=[^&\s<>]+' "$artifact"
rg -n --pcre2 'postgres(ql)?://[^\s:/@]+:[^\s@]+@' "$artifact"
```

Result:

- JWT-shaped token matches: `0`.
- Bearer header matches: `0`.
- Secret query parameter matches: `0`.
- Raw Postgres userinfo matches: `0`.

## Conclusion

The 142 deployment is signed off for the Data Factory postdeploy surface added
in PR #1525. The deployed instance serves both integration frontend routes, the
authenticated integration control-plane checks pass, and the downloaded evidence
artifact contains no token or connection-string leakage.

Customer live K3 WISE remains blocked until the customer GATE packet and test
account are available.
