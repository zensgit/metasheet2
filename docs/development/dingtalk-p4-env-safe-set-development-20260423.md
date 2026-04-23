# DingTalk P4 Env Safe Set Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-env-safe-set-20260423`
- Base: `origin/main` at `76ddfeacd`
- Scope: add a safe non-echoing way to fill the private DingTalk P4 staging env file

## Problem

`$HOME/.config/yuantus/dingtalk-p4-staging.env` exists with private `0600` permissions, but the required secret and target fields are still blank. Operators previously had to edit the file manually, and the only automated command was readiness checking after the fact.

Manual editing creates two avoidable risks:

- secret values can be accidentally pasted into shell output or committed files during debugging;
- malformed or unsupported keys can be added without feedback until the release-readiness gate fails.

## Changes

- Extended `scripts/ops/dingtalk-p4-env-bootstrap.mjs` with safe update actions:
  - `--set KEY=VALUE` for known DingTalk P4 env keys;
  - `--set-from-env KEY` to copy secret values from the process environment without placing them in command output;
  - `--unset KEY` to blank a known key.
- Restricted updates to the existing DingTalk P4 key allowlist.
- Preserved private file permissions by rewriting the env file with `0600` and calling `chmodSync(..., 0o600)`.
- Redacted all secret-key update output. Secret values are never printed; non-secret list fields print counts only.
- Added focused tests for safe update, missing process env values, unknown keys, and post-update readiness.

## Operator Flow

```bash
DINGTALK_P4_AUTH_TOKEN="<jwt>" \
node scripts/ops/dingtalk-p4-env-bootstrap.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --set-from-env DINGTALK_P4_AUTH_TOKEN \
  --set 'DINGTALK_P4_GROUP_A_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...' \
  --set 'DINGTALK_P4_GROUP_B_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...' \
  --set 'DINGTALK_P4_ALLOWED_USER_IDS=<authorized-local-user-id>' \
  --set 'DINGTALK_P4_UNAUTHORIZED_USER_ID=<unauthorized-local-user-id>' \
  --set 'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID=<no-email-dingtalk-external-id>'
```

Then run:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops
```

Only when release readiness passes should the real 142 remote smoke session start.

## Non-Goals

- No real staging secret values were added to the repository.
- No remote smoke was executed in this slice.
- No DingTalk webhook or backend API call was made by the new update path.
