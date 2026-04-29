# DingTalk OAuth Stability Webhook Secret Fallback Design

## Context

The scheduled `DingTalk OAuth Stability Recording (Lite)` run
`25109850840` failed with:

- `STABILITY_RC=0`
- `HEALTHY=false`
- failure reason: `Alertmanager webhook is not configured`

The uploaded evidence showed that backend health, Alertmanager notify errors,
and the root disk gate were not the blocking issue. The workflow attempted the
webhook self-heal step, but `secrets.SLACK_WEBHOOK_URL` was empty, so the step
skipped and the remote Alertmanager env file remained absent.

The repository uses more than one webhook naming convention:

- `.env.example` documents `ALERT_WEBHOOK_URL`.
- older Phase 5 workflows use `SLACK_WEBHOOK_URL`.
- attendance notification workflows use `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`.
- the on-prem helper writes `ALERTMANAGER_WEBHOOK_URL` into the remote
  Alertmanager env file.

Requiring only `SLACK_WEBHOOK_URL` makes the self-heal path brittle when the
repository has a valid webhook stored under a more specific or newer name.

## Change

`.github/workflows/dingtalk-oauth-stability-recording-lite.yml` now resolves the
webhook secret with this order:

1. `secrets.ALERTMANAGER_WEBHOOK_URL`
2. `secrets.ALERT_WEBHOOK_URL`
3. `secrets.SLACK_WEBHOOK_URL`
4. `secrets.ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`

The selected value is still passed only through the existing
`ALERTMANAGER_WEBHOOK_URL` environment variable to
`scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh set`.

If no supported secret is set, the workflow still emits a notice and continues
to the remote stability check. The final `healthy=false` gate is unchanged, so
missing webhook configuration remains visible as a failed stability run.

The workflow also records whether a webhook secret was available and passes that
fact into `scripts/ops/github-dingtalk-oauth-stability-summary.py`. When the
remote report says the Alertmanager webhook is not configured and no supported
GitHub secret was available for self-heal, the summary artifact now names that
missing-secret condition directly.

## Safety

- No webhook value is printed to logs.
- The helper still validates the URL scheme and host.
- The remote file is still written with `install -m 600`.
- The workflow does not weaken the final health gate.
- The summary only records whether a supported secret was present; it never
  prints the secret value.
- This change only broadens secret discovery; it does not create, rotate, or
  store any secret.

## Expected Outcome

If the repo already has a valid webhook under one of the supported names, the
next scheduled/manual stability run should self-heal the remote Alertmanager
env file before checking health.

If none of the supported secrets exists, the run will still fail with the same
clear operator action in the summary artifact: configure one supported webhook
secret or manually restore the on-prem Alertmanager env file.
