# K3 WISE Postdeploy Smoke Verification

## Environment

Executed from isolated worktree:

```bash
/tmp/ms2-integration-k3wise-postdeploy-smoke-20260428
```

Base branch:

```bash
origin/main d0151f8cb
```

## Checks

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs

node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --help

node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://142.171.239.56:8081 \
  --out-dir output/integration-k3wise-postdeploy-smoke/current-public
```

## Results

`node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`

- Passed: 4 tests.
- Covered public smoke without auth.
- Covered protected `/api/integration/health` returning `401` without auth.
- Covered authenticated route/staging contract checks.
- Covered `--require-auth` failure behavior when no token is supplied.
- Covered token redaction in stdout, stderr, and JSON evidence.

`node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --help`

- Passed.
- Printed CLI usage and environment fallback contract.

Public 142 deployment smoke:

```json
{
  "ok": true,
  "baseUrl": "http://142.171.239.56:8081",
  "authenticated": false,
  "summary": {
    "pass": 2,
    "skipped": 2,
    "fail": 0
  }
}
```

Public evidence details:

- `api-health`: pass, `plugins=13`, `pluginsSummary.failed=0`.
- `integration-plugin-health`: skipped because this deployment requires auth for `/api/integration/health`.
- `k3-wise-frontend-route`: pass, HTTP 200 app shell.
- `authenticated-integration-contract`: skipped because no bearer token was supplied.

Generated local evidence:

- `output/integration-k3wise-postdeploy-smoke/current-public/integration-k3wise-postdeploy-smoke.json`
- `output/integration-k3wise-postdeploy-smoke/current-public/integration-k3wise-postdeploy-smoke.md`

The generated `output/` evidence is not committed.

## Follow-up Auth Signoff

When an application admin token is available, run:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://142.171.239.56:8081 \
  --token-file /path/to/token.txt \
  --require-auth \
  --out-dir output/integration-k3wise-postdeploy-smoke/current-auth
```

Expected authenticated additions:

- `auth-me`: pass.
- `integration-route-contract`: pass with K3 WebAPI and SQL Server adapter kinds registered.
- `staging-descriptor-contract`: pass with `standard_materials` and `bom_cleanse`.
