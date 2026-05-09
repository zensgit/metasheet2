# K3 WISE Smoke Failure Evidence Verification

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/integration-k3wise-postdeploy-smoke.yml"); puts "workflow yaml ok"'
git diff --check
```

## Expected Result

- Workflow contract test confirms the manual token resolver:
  - has `id: token_resolve`;
  - uses `continue-on-error: true`;
  - writes `token_resolve_rc`;
  - is checked by the final gate.
- Existing smoke tests continue to prove unauthenticated `--require-auth`
  executions write blocked signoff evidence.
- Existing summary tests continue to render missing or blocked evidence without
  treating it as an internal-trial pass.
- Workflow YAML parses.
- Diff has no whitespace errors.

## Live Verification Target

Re-run the manual workflow after merge with:

```text
base_url=http://142.171.239.56:8081
require_auth=true
auto_discover_tenant=true
timeout_ms=10000
```

If the deployment still has no smoke token, no explicit tenant, and no singleton
integration tenant scope, the workflow should still fail, but it should upload
`integration-k3wise-postdeploy-smoke-<run>-<attempt>` with blocked signoff
evidence.
