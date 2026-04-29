# DingTalk OAuth Stability Webhook Self-Heal Verification

## Commands

```bash
bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
bash -n scripts/ops/dingtalk-oauth-stability-check.sh
python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py
node --test scripts/ops/dingtalk-oauth-stability-workflow-contract.test.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/dingtalk-oauth-stability-recording-lite.yml"); puts "workflow yaml ok"'
git diff --check
```

## Expected Result

- Shell syntax passes for both ops scripts.
- Stability summary Python compiles.
- Workflow contract test confirms:
  - the workflow still prepares the deploy SSH key;
  - the new self-heal step reads `SLACK_WEBHOOK_URL`;
  - the self-heal step uses the deploy host/user and deploy key;
  - the self-heal step runs before the remote stability check;
  - the final `healthy=false` gate remains present.
- Workflow YAML parses.
- Diff has no whitespace errors.

## Observed Result

Run from `/tmp/ms2-dingtalk-stability-followup-20260429` on 2026-04-29:

- `bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh` passed.
- `bash -n scripts/ops/dingtalk-oauth-stability-check.sh` passed.
- `python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py` passed.
- `node --test scripts/ops/dingtalk-oauth-stability-workflow-contract.test.mjs` passed: 1/1.
- Workflow YAML parse passed.
- `git diff --check` passed.

## Live Follow-Up

After merge, trigger `DingTalk OAuth Stability Recording (Lite)` or wait for the
next scheduled run. If `SLACK_WEBHOOK_URL` is configured correctly, the workflow
should reapply the on-prem Alertmanager env file before checking health. If the
secret is absent, invalid, or revoked, the run should still fail with the
existing `Alertmanager webhook is not configured` or host-drift reason.
