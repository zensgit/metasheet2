# K3 WISE Postdeploy Auth Token Resolution Verification

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
- Resolver test covers:
  - configured secret writes a masked token to `GITHUB_ENV`;
  - optional auth exits zero when tenant input is missing;
  - required auth fails when tenant input is missing;
  - optional deploy-host fallback exits zero when SSH inputs are missing;
  - required deploy-host fallback fails when SSH inputs are missing.
- Workflow contract test confirms both workflow entrypoints call the resolver
  before running the smoke and pass resolved `K3_WISE_SMOKE_TOKEN` through
  `METASHEET_AUTH_TOKEN`.
- Existing smoke and summary tests continue to pass.
- Workflow YAML parses.
- Diff has no whitespace errors.

## Live Follow-Up

After this lands on `main`, the next deploy can authenticate the K3 WISE
postdeploy smoke without a long-lived repo token if `METASHEET_TENANT_ID` and the
normal deploy SSH secrets are present. The deploy path remains non-blocking when
those inputs are absent.

For an operator signoff run, trigger `K3 WISE Postdeploy Smoke` with
`require_auth=true` and `tenant_id=<target tenant id>`. That path intentionally
fails early unless it can resolve an authenticated token.
