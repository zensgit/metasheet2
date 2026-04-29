# K3 WISE Postdeploy Workflow Verification

## Environment

Worktree:

```bash
/tmp/ms2-k3wise-postdeploy-workflow-20260429
```

Base:

```bash
origin/main bf4cb7ec3
```

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs

ruby -e 'require "yaml"; YAML.load_file(".github/workflows/docker-build.yml"); puts "workflow yaml ok"'

rm -rf output/deploy/k3wise-postdeploy-smoke-local
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://142.171.239.56:8081 \
  --out-dir output/deploy/k3wise-postdeploy-smoke-local

git diff --check
```

## Results

`node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`

- Passed: 4/4 tests.
- Covered public-only smoke.
- Covered protected integration route behavior.
- Covered authenticated contract checks.
- Covered `--require-auth` missing-token failure and token redaction.

Workflow YAML parse:

- Passed with Ruby `YAML.load_file`.
- `actionlint` was not installed in this environment.

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

Step-summary renderer simulation:

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

Whitespace check:

- `git diff --check`: passed.

## Notes

The full deploy workflow can only be proven on `main` after merge because `.github/workflows/docker-build.yml` deploys from the default branch and requires production deploy secrets. The local verification covered the workflow YAML syntax, the smoke script behavior, and the summary renderer against real public 142 output.
