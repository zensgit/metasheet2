# DingTalk P4 Env Safe Set Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-env-safe-set-20260423`
- Base: `origin/main` at `76ddfeacd`
- Result: safe env update tooling passes; real 142 remote smoke remains blocked because private staging values are still blank

## Current Real Env Status

Checked `$HOME/.config/yuantus/dingtalk-p4-staging.env` without printing raw secret values.

- File exists.
- File mode is `0600`.
- `DINGTALK_P4_AUTH_TOKEN` is blank.
- `DINGTALK_P4_GROUP_A_WEBHOOK` is blank.
- `DINGTALK_P4_GROUP_B_WEBHOOK` is blank.
- Allowlist fields are blank.
- Manual target identities are blank.

Release readiness with the real private env was run with `--allow-failures` and produced:

- Output: `output/dingtalk-p4-release-readiness/real-env-20260423-152945/release-readiness-summary.json`
- Overall status: `fail`
- Regression gate: `pass`, 10 passed / 0 failed / 0 skipped
- Failed env checks: `dingtalk_p4_auth_token`, `dingtalk_p4_group_a_webhook`, `group-a-webhook-shape`, `dingtalk_p4_group_b_webhook`, `group-b-webhook-shape`, `allowlist-present`, `manual-targets-declared`

## Commands Run

```bash
node --check scripts/ops/dingtalk-p4-env-bootstrap.mjs
node --check scripts/ops/dingtalk-p4-env-bootstrap.test.mjs
```

- Result: pass.

```bash
node --test scripts/ops/dingtalk-p4-env-bootstrap.test.mjs
```

- Result: pass, 6 tests.

```bash
node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs
```

- Result: pass, 12 tests.

```bash
TMPDIR=$(mktemp -d)
ENV_FILE="$TMPDIR/dingtalk-p4.env"
OUT="$TMPDIR/readiness"
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --init --p4-env-file "$ENV_FILE"
DINGTALK_P4_AUTH_TOKEN='secret-admin-token' \
node scripts/ops/dingtalk-p4-env-bootstrap.mjs \
  --p4-env-file "$ENV_FILE" \
  --set-from-env DINGTALK_P4_AUTH_TOKEN \
  --set 'DINGTALK_P4_GROUP_A_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a' \
  --set 'DINGTALK_P4_GROUP_B_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b' \
  --set 'DINGTALK_P4_ALLOWED_USER_IDS=user_authorized' \
  --set 'DINGTALK_P4_UNAUTHORIZED_USER_ID=user_unauthorized' \
  --set 'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID=dt_no_email_001'
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --check --p4-env-file "$ENV_FILE" --output-dir "$OUT"
```

- Result: readiness pass.
- Stdout was checked for `secret-admin-token`, `robot-secret-a`, and `robot-secret-b`; none were printed.

## Residual Risk

The new helper makes filling the env safer, but it does not create or discover the real values. A maintainer still needs to provide the staging admin JWT, two DingTalk robot webhooks, allowlist IDs, unauthorized user ID, and no-email DingTalk external ID before real remote smoke can run.
