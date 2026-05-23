# GitHub Remote IP Refresh - 2026-05-23

## Context

The active MetaSheet deployment host moved from `142.171.239.56` to
`23.254.236.11`.

This slice updates only current executable configuration and GitHub-facing
defaults. Historical verification reports that mention the old host are left
unchanged because they describe past runs.

## Changes

- Updated GitHub Actions workflow defaults from the old host to
  `23.254.236.11` for current remote smoke, Yjs staging validation, and
  attendance perf/smoke gates.
- Updated deploy-time K3 WISE smoke fallbacks to prefer GitHub Variables before
  falling back to the new host.
- Updated `docker/app.staging.env.example` to use the current staging web origin
  on port `8082`, including the DingTalk callback URL.
- Updated the K3 WISE postdeploy smoke script default base URL to the current
  host.
- Updated `.github/workflows/README.md` to refer to configured `DEPLOY_HOST`
  instead of a hard-coded host.

## GitHub Settings Updated

The following repository settings were updated with `gh`:

- Secret `DEPLOY_HOST`: set to the new host.
- Variable `METASHEET_BASE_URL`: `http://23.254.236.11:8081`
- Variable `PUBLIC_APP_URL`: `http://23.254.236.11:8081`
- Variable `METASHEET_FRONTEND_BASE_URL`: `http://23.254.236.11:8081`
- Variable `ATTENDANCE_API_BASE`: `http://23.254.236.11:8081/api`
- Variable `ATTENDANCE_WEB_BASE_URL`: `http://23.254.236.11:8081`
- Variable `DINGTALK_P4_API_BASE`: `http://23.254.236.11:8081`
- Variable `DINGTALK_P4_WEB_BASE`: `http://23.254.236.11:8081`

`DINGTALK_P4_API_BASE` intentionally uses port `8081`; direct public access to
port `8900` returned an empty reply from this workstation, while the nginx path
on `8081` returned the expected authentication response.

## Verification

Commands run:

```bash
rg -n "142\\.171\\.239\\.56" \
  .github docker/app.staging.env.example \
  scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs

gh variable list --repo zensgit/metasheet2 | \
  rg 'METASHEET_BASE_URL|PUBLIC_APP_URL|METASHEET_FRONTEND_BASE_URL|ATTENDANCE_API_BASE|ATTENDANCE_WEB_BASE_URL|DINGTALK_P4_API_BASE|DINGTALK_P4_WEB_BASE'

gh secret list --repo zensgit/metasheet2 | rg '^DEPLOY_HOST\\b'

curl -sS -m 5 -i http://23.254.236.11:8081/api/auth/me
curl -sS -m 5 -i http://23.254.236.11:8900/api/auth/me

node scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node scripts/ops/attendance-import-perf-longrun-workflow-contract.test.mjs
node scripts/ops/attendance-locale-zh-workflow-contract.test.mjs

ruby -e 'ARGV.each { |f| require "yaml"; YAML.load_file(f); puts "yaml_ok #{f}" }' \
  .github/workflows/yjs-staging-validation.yml \
  .github/workflows/integration-k3wise-postdeploy-smoke.yml \
  .github/workflows/docker-build.yml \
  .github/workflows/attendance-import-perf-highscale.yml \
  .github/workflows/attendance-locale-zh-smoke-prod.yml \
  .github/workflows/attendance-strict-gates-prod.yml \
  .github/workflows/attendance-import-perf-baseline.yml \
  .github/workflows/attendance-import-perf-longrun.yml
```

Observed results:

- Target current workflow/config files no longer contain `142.171.239.56`.
- GitHub Variables list shows the new `23.254.236.11` values.
- GitHub Secret `DEPLOY_HOST` has a fresh update timestamp for this run.
- `http://23.254.236.11:8081/api/auth/me` returns `401 Missing Bearer token`,
  which confirms public nginx-to-backend routing is live.
- `http://23.254.236.11:8900/api/auth/me` returns an empty reply, so public
  GitHub-runner traffic should use `8081`.
- K3 WISE postdeploy workflow contract: `2 pass`.
- Attendance import longrun workflow contract: `2 pass`.
- Attendance locale zh workflow contract: `2 pass`.
- Changed workflow YAML files parsed successfully with Ruby Psych.

Additional note:

- `node scripts/ops/attendance-run-workflow-dispatch.test.mjs` was also tried
  as a broader workflow-adjacent check and failed on an existing
  `workflow_run_args[@]: unbound variable` path in
  `scripts/ops/attendance-run-workflow-dispatch.sh`. That failure is not caused
  by this IP refresh and was left out of scope for this slice.
