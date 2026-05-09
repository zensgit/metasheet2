# DingTalk P4 Env Secret Setter Hardening Development

Date: 2026-04-29

## Goal

Reduce accidental secret exposure while preparing the private DingTalk P4 staging env file.

## Design

- Keep `--set KEY=VALUE` for non-secret DingTalk P4 keys such as allowlisted users, manual target IDs, and base URLs.
- Reject `--set KEY=VALUE` for secret-bearing keys:
  - `DINGTALK_P4_AUTH_TOKEN`
  - `DINGTALK_P4_GROUP_A_WEBHOOK`
  - `DINGTALK_P4_GROUP_B_WEBHOOK`
  - `DINGTALK_P4_GROUP_A_SECRET`
  - `DINGTALK_P4_GROUP_B_SECRET`
- Require secret-bearing keys to be updated with `--set-from-env KEY`, so values do not need to be typed directly into shell history.
- Keep existing output redaction: update logs show only `<redacted>` and character counts for secret-bearing keys.

## Operator Flow

```bash
export DINGTALK_P4_GROUP_A_WEBHOOK="<private value>"
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --set-from-env DINGTALK_P4_GROUP_A_WEBHOOK
```

## Compatibility

Existing private env files remain compatible. This only changes the update path for future secret writes.

