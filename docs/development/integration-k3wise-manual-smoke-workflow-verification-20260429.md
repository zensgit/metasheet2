# K3 WISE Manual Smoke Workflow Verification

## Environment

Worktree:

```bash
/tmp/ms2-k3wise-postdeploy-manual-20260429
```

Base:

```bash
origin/main a9b3cf6ae
```

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs

node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs

ruby -e 'require "yaml"; YAML.load_file(".github/workflows/docker-build.yml"); YAML.load_file(".github/workflows/integration-k3wise-postdeploy-smoke.yml"); puts "workflow yaml ok"'

node --check scripts/ops/integration-k3wise-postdeploy-summary.mjs
node --check scripts/ops/integration-k3wise-postdeploy-summary.test.mjs

rm -rf output/integration-k3wise-postdeploy-smoke/manual-local
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://142.171.239.56:8081 \
  --out-dir output/integration-k3wise-postdeploy-smoke/manual-local

node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input output/integration-k3wise-postdeploy-smoke/manual-local/integration-k3wise-postdeploy-smoke.json

git diff --check
```

## Results

Summary renderer tests:

- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`: 5/5 passed.
- Covered pass evidence rendering.
- Covered fail evidence rendering without failing the renderer.
- Covered `--missing-ok` for always-run workflow summaries.
- Covered missing evidence default failure.
- Covered `--help`.

Existing smoke tests:

- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`: 4/4 passed.
- No regression in public, protected-route, authenticated, or `--require-auth` behavior.

Workflow syntax:

- `docker-build.yml`: parsed successfully.
- `integration-k3wise-postdeploy-smoke.yml`: parsed successfully.
- `actionlint` was not installed in this environment.

Script syntax:

- `node --check scripts/ops/integration-k3wise-postdeploy-summary.mjs`: passed.
- `node --check scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`: passed.

Public 142 smoke:

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

Summary renderer output:

```markdown
- Status: **PASS**
- Base URL: `http://142.171.239.56:8081`
- Authenticated checks: `no`
- Summary: `2 pass / 2 skipped / 0 fail`
- Checks:
  - `api-health`: `pass`
  - `integration-plugin-health`: `skipped`
  - `k3-wise-frontend-route`: `pass`
  - `authenticated-integration-contract`: `skipped`
```

Whitespace:

- `git diff --check`: passed.

## Notes

The manual workflow can only be executed from GitHub Actions after merge because workflow files must exist on the default branch before `workflow_dispatch` is available. Local verification covered the shared renderer, existing smoke behavior, workflow YAML syntax, and real public 142 output.
