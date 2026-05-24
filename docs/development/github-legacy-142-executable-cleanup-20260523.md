# GitHub legacy 142 executable cleanup - 2026-05-23

## Context

PR #1784 moved the active deployment target from `142.171.239.56` to
`23.254.236.11` and refreshed current GitHub workflow defaults plus repository
variables/secrets.

This follow-up removes the remaining old-host defaults from executable scripts,
runtime smoke helpers, and test fixtures. Historical verification reports under
`docs/**` are intentionally not rewritten because they describe past runs.

## Changes

- Updated attendance post-merge, perf, gate, and smoke helper defaults/examples
  to use `http://23.254.236.11:8081` or `http://23.254.236.11:8081/api`.
- Updated Yjs node validation default/example to use
  `http://23.254.236.11:8081`.
- Updated DingTalk P4 env bootstrap/session templates and tests to use the
  current public nginx route on `8081`, not the old public `8900` route.
- Updated on-prem DingTalk alertmanager and Docker GC SSH defaults from
  `mainuser@142.171.239.56` to `mainuser@23.254.236.11`.
- Updated related Node test fixtures so contract tests match the new operational
  defaults.

## Permission follow-up

`adharamans` still had repository `read` permission when this follow-up started.
The GitHub API accepted a `permission=push` collaborator update request and
returned a pending invitation with `permissions: write`.

Observed follow-up check:

```bash
gh api repos/zensgit/metasheet2/collaborators/adharamans/permission \
  --jq '{permission:.permission, role_name:.role_name, user:.user.login}'
```

Result immediately after the invitation was still:

```json
{"permission":"read","role_name":"read","user":"adharamans"}
```

Conclusion: the reviewer must accept the pending invitation before their future
approval counts as a write-level collaborator approval.

## Verification

Commands run:

```bash
rg -n "142\\.171\\.239\\.56" scripts packages .github docker \
  -g '!node_modules' -g '!dist' -g '!build' -g '!coverage'

node --check scripts/ops/attendance-smoke-api.mjs
node --check scripts/ops/attendance-import-perf.mjs
node --check scripts/ops/dingtalk-p4-env-bootstrap.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/verify-multitable-rc-staging-smoke.mjs
node --check packages/core-backend/scripts/ops/yjs-node-client.mjs

bash -n \
  scripts/ops/attendance-post-merge-verify.sh \
  scripts/ops/attendance-run-gates.sh \
  scripts/ops/attendance-run-perf-high-scale.sh \
  scripts/ops/attendance-run-perf-highscale.sh \
  scripts/ops/attendance-run-strict-gates-twice.sh \
  scripts/ops/dingtalk-oauth-stability-check.sh \
  scripts/ops/dingtalk-onprem-docker-gc.sh \
  scripts/ops/install-dingtalk-onprem-docker-gc.sh \
  scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh

node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-final-input-status.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-alertmanager-closeout.test.mjs \
  scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs
```

Observed results:

- Executable-scope old-host scan: no matches in `scripts`, `packages`,
  `.github`, or `docker`.
- Node syntax checks: passed.
- Shell syntax checks: passed.
- Targeted Node test run: `63 passed`.

