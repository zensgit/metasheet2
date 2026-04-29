# K3 WISE Postdeploy Tenant Auto-Discovery Verification

## Commands

```bash
bash -n scripts/ops/resolve-k3wise-smoke-token.sh
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f) }; puts "workflow yaml ok"' \
  .github/workflows/docker-build.yml \
  .github/workflows/integration-k3wise-postdeploy-smoke.yml
git diff --check
```

## Expected Result

- Resolver shell syntax passes.
- Resolver tests pass and cover:
  - configured long-lived token still wins;
  - optional missing tenant still exits zero;
  - required missing tenant still fails;
  - deploy-host fallback can run without explicit tenant only when
    `K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=true`;
  - resolved singleton tenant is written to `K3_WISE_SMOKE_TENANT_ID`;
  - default disabled auto-discovery keeps the missing-tenant warning explicit.
- Workflow contract test confirms:
  - manual workflow exposes `auto_discover_tenant`;
  - deploy workflow reads repo variable
    `K3_WISE_TOKEN_AUTO_DISCOVER_TENANT`;
  - both smoke steps pass the resolved tenant fallback to `--tenant-id`.
- Existing postdeploy smoke and summary tests continue to pass.
- Workflow YAML parses.
- Diff has no whitespace errors.

## Live Follow-Up

After merge, the next deploy still stays public-only unless either
`METASHEET_TENANT_ID` is configured or
`K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=true` is explicitly enabled and the deployed
integration tables contain exactly one tenant scope.

For an operator signoff run, trigger `K3 WISE Postdeploy Smoke` with
`require_auth=true`. Prefer filling `tenant_id`; use `auto_discover_tenant=true`
only for known singleton deployments.

## Observed Result

Run from `/tmp/ms2-k3wise-tenant-resolve-20260429` on 2026-04-29:

- `bash -n scripts/ops/resolve-k3wise-smoke-token.sh` passed.
- `node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs` passed: 7/7.
- `node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` passed: 14/14.
- Workflow YAML parse passed for both changed workflows.
- `git diff --check` passed.
