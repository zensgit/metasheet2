# K3 WISE Postdeploy Tenant Scope Workflow Verification

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f) }; puts "workflow yaml ok"' \
  .github/workflows/docker-build.yml \
  .github/workflows/integration-k3wise-postdeploy-smoke.yml
git diff --check
```

## Expected Result

- Workflow contract test passes and asserts tenant scope wiring in both
  workflow entrypoints.
- Smoke test passes and asserts explicit CLI tenant scope plus
  `METASHEET_TENANT_ID` env fallback are sent to all four authenticated list
  probes.
- Existing summary tests continue to pass.
- Workflow YAML still parses.
- Diff has no whitespace errors.

## Live Follow-Up

After `METASHEET_K3WISE_SMOKE_TOKEN` is available, run the manual workflow with:

- `require_auth=true`
- `tenant_id=<target tenant id>` or repo variable `METASHEET_TENANT_ID`

That follow-up is intentionally separate from this PR because SSH access to the
142 host timed out while attempting to generate a fresh app JWT in this session.
