# DingTalk P4 Final Input Handoff

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Baseline commit: `8205f0d10`
- Goal: collect the final private inputs needed before the real 142/DingTalk P4 smoke session

## Current Readiness State

- Private env template exists at `output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env`.
- The env file is ignored by git and should remain private.
- `DINGTALK_P4_API_BASE` and `DINGTALK_P4_WEB_BASE` are filled with the 142 defaults.
- `DINGTALK_P4_AUTH_TOKEN` is filled in the ignored env and has been validated with `/api/auth/me`.
- `DINGTALK_P4_ALLOWED_USER_IDS`, `DINGTALK_P4_PERSON_USER_IDS`, and `DINGTALK_P4_AUTHORIZED_USER_ID` are filled with the known active DingTalk-bound admin user.
- Readiness still fails until the final private inputs below are supplied.

## Inputs To Collect

- `DINGTALK_P4_GROUP_A_WEBHOOK`: real DingTalk group robot webhook URL for group A.
- `DINGTALK_P4_GROUP_B_WEBHOOK`: real DingTalk group robot webhook URL for group B.
- `DINGTALK_P4_GROUP_A_SECRET`: optional `SEC...` signing secret if group A requires robot signing.
- `DINGTALK_P4_GROUP_B_SECRET`: optional `SEC...` signing secret if group B requires robot signing.
- `DINGTALK_P4_UNAUTHORIZED_USER_ID`: a second active DingTalk-bound local user that is not in the allowed list.
- `DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID`: a DingTalk external identity that has no existing local user/email and can be used for admin create-and-bind proof.

## Safe Set Commands

Run these locally on the operator machine or on the 142 host. Do not paste values into tracked docs, shell history shared logs, or PR comments.

```bash
export DINGTALK_P4_GROUP_A_WEBHOOK='<real-group-a-webhook>'
export DINGTALK_P4_GROUP_B_WEBHOOK='<real-group-b-webhook>'
export DINGTALK_P4_GROUP_A_SECRET='<optional-sec-secret-or-empty>'
export DINGTALK_P4_GROUP_B_SECRET='<optional-sec-secret-or-empty>'
export DINGTALK_P4_UNAUTHORIZED_USER_ID='<second-dingtalk-bound-local-user-id>'
export DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID='<no-email-dingtalk-external-id>'

node scripts/ops/dingtalk-p4-env-bootstrap.mjs \
  --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --set-from-env DINGTALK_P4_GROUP_A_WEBHOOK \
  --set-from-env DINGTALK_P4_GROUP_B_WEBHOOK \
  --set-from-env DINGTALK_P4_GROUP_A_SECRET \
  --set-from-env DINGTALK_P4_GROUP_B_SECRET \
  --set-from-env DINGTALK_P4_UNAUTHORIZED_USER_ID \
  --set-from-env DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID
```

If a robot has no signing secret, leave its secret variable empty and use `--unset DINGTALK_P4_GROUP_A_SECRET` or `--unset DINGTALK_P4_GROUP_B_SECRET`.

## Readiness Command

First run the offline final-input status check. This does not call 142 or DingTalk and only emits redacted reports:

```bash
node scripts/ops/dingtalk-p4-final-input-status.mjs \
  --env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --output-json output/dingtalk-p4-final-input-status/142-final-inputs/summary.json \
  --output-md output/dingtalk-p4-final-input-status/142-final-inputs/summary.md
```

Then run the release-readiness gate:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --regression-profile all \
  --regression-plan-only \
  --output-dir output/dingtalk-p4-release-readiness/142-final-inputs \
  --allow-failures
```

Expected result before the final smoke session:

- `overallStatus` is `manual_pending` or `pass` depending on whether the regression gate is still plan-only.
- `env-readiness` has no failed checks.
- `authTokenPresent` is `true`.
- `allowedUserCount` is at least 1.
- `personUserCount` is at least 1.
- `manualTargets.authorizedUserId`, `manualTargets.unauthorizedUserId`, and `manualTargets.noEmailDingTalkExternalId` are all populated.
- Both group webhooks are redacted but shape-valid in the generated readiness summary.

## Smoke Launch Command

Run this only after readiness passes and the operator has confirmed the API base is reachable from the machine running the command.

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --regression-profile all \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --timeout-ms 120000
```

If `DINGTALK_P4_API_BASE=http://142.171.239.56:8900` is not reachable from the operator machine, run the command on the 142 host or switch to a verified routable API base.

## Stop Conditions

- Do not run the real smoke session with placeholder webhooks.
- Do not use the same user for authorized and unauthorized checks.
- Do not invent a no-email external id; it must exist in DingTalk sync data and must not already be bound to a local user/email.
- Do not commit `output/dingtalk-p4-remote-smoke-session/`, readiness output, screenshots, raw packet contents, webhook URLs, robot secrets, JWTs, public form tokens, or temporary passwords.

## Final Completion

After the real smoke and manual evidence are complete, run:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260424
```

The final closeout should generate the release-ready development and verification Markdown for the real 142/DingTalk run.
