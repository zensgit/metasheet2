# K3 WISE Postdeploy Workflow Contract Verification

## Scope

Verify the workflow contract test added for the K3 WISE postdeploy smoke chain.

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

- Workflow contract test passes.
- Existing postdeploy smoke and summary tests continue to pass.
- Both workflow YAML files parse successfully.
- Diff has no whitespace errors.

## Live Environment

This verification is intentionally local and read-only. It does not contact:

- customer PLM;
- customer K3 WISE;
- customer SQL Server;
- customer middleware or VPN.

The previous post-merge workflow evidence remains the live deployment proof for `main`; this change adds a regression guard so future YAML edits keep that path intact.
