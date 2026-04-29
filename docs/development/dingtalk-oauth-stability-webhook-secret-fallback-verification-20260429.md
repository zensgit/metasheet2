# DingTalk OAuth Stability Webhook Secret Fallback Verification

## Environment

Executed from isolated worktree:

```bash
/tmp/ms2-dingtalk-oauth-stability-20260429
```

Base branch:

```bash
origin/main c3695f0e6
```

## Evidence From Failed Run

Downloaded artifact from GitHub run `25109850840`:

- workflow: `DingTalk OAuth Stability Recording (Lite)`
- event: `schedule`
- command result: `STABILITY_RC=0`
- health result: `HEALTHY=false`
- summary failure reason: `Alertmanager webhook is not configured`
- backend health: `status=ok plugins=13 ok=True`
- Alertmanager notify errors: `0`
- root storage: `94% / 95% max`

Workflow log for the self-heal step showed:

- `ALERTMANAGER_WEBHOOK_URL` was empty.
- the workflow emitted the skip notice.
- no remote webhook config was reapplied before the health check.

## Local Checks

```bash
bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash -n scripts/ops/dingtalk-oauth-stability-check.sh
python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py
node --test scripts/ops/dingtalk-oauth-stability-workflow-contract.test.mjs
node --test scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/dingtalk-oauth-stability-recording-lite.yml"); puts "workflow yaml ok"'
git diff --check
```

## Expected Assertions

- The workflow keeps the deploy SSH key setup.
- The self-heal step runs before the remote stability check.
- The self-heal step resolves the webhook secret from:
  - `ALERTMANAGER_WEBHOOK_URL`
  - `ALERT_WEBHOOK_URL`
  - `SLACK_WEBHOOK_URL`
  - `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`
- The skip notice names every supported secret.
- The workflow passes `WEBHOOK_SECRET_AVAILABLE` to the summary renderer.
- The summary renderer adds a missing-secret failure reason and next action
  when the remote webhook is unconfigured and self-heal had no supported secret.
- The final `healthy=false` hard gate remains present.
- Shell syntax, Python syntax, workflow YAML parsing, and whitespace checks pass.

## Observed Local Result

- `bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh` passed.
- `bash -n scripts/ops/dingtalk-oauth-stability-check.sh` passed.
- `python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py` passed.
- `node --test scripts/ops/dingtalk-oauth-stability-workflow-contract.test.mjs` passed: 1/1.
- `node --test scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs` passed: 1/1.
- Workflow YAML parse passed.
- `git diff --check` passed.

## Current GitHub Secret State

`gh secret list --repo zensgit/metasheet2 --json name,updatedAt` showed no
supported webhook secret name at verification time. The available repo secrets
were deploy/admin related only:

- `ATTENDANCE_ADMIN_GH_TOKEN`
- `ATTENDANCE_ADMIN_JWT`
- `DEPLOY_COMPOSE_FILE`
- `DEPLOY_HOST`
- `DEPLOY_PATH`
- `DEPLOY_SSH_KEY`
- `DEPLOY_SSH_KEY_B64`
- `DEPLOY_USER`

Therefore this code change improves discovery and operator diagnostics, but the
scheduled stability workflow still needs one supported webhook secret to be
configured before it can self-heal the remote Alertmanager file.

## Live Follow-Up

After merge, run `DingTalk OAuth Stability Recording (Lite)` manually or wait
for the next scheduled run. A PASS requires both:

- one supported webhook secret configured in GitHub;
- the remote stability report returning `healthy=true`.

This PR cannot prove secret presence locally because GitHub secret values are
not readable by design.
