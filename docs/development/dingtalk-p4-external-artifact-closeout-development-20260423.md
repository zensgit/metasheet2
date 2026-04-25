# DingTalk P4 External Artifact Closeout Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: preserve `--allow-external-artifact-refs` across final auto-finalize and closeout chains

## Problem

The strict compiler supports `--allow-external-artifact-refs` for cases where final manual artifacts live in an approved persistent location outside the session workspace. `dingtalk-p4-final-closeout.mjs` already forwards that flag to its strict finalize step.

Two recommended chains did not preserve it:

- `dingtalk-p4-smoke-session.mjs --finalize --allow-external-artifact-refs` produced a final closeout next command without the same flag.
- `dingtalk-p4-evidence-record.mjs --finalize-when-ready` and `--closeout-when-ready` had no way to forward the flag.

That could make a session finalize successfully, then fail during the recommended closeout rerun when the same external artifacts were revalidated without the allowance.

## Changes

- `dingtalk-p4-smoke-session.mjs` now includes `--allow-external-artifact-refs` in the generated `dingtalk-p4-final-closeout.mjs` next command when the finalize command used that option.
- `dingtalk-p4-evidence-record.mjs` now accepts `--allow-external-artifact-refs`.
- Evidence recorder auto-finalize forwards the flag to `dingtalk-p4-smoke-session.mjs --finalize`.
- Evidence recorder auto-closeout forwards the flag to `dingtalk-p4-final-closeout.mjs`.
- Error recovery command text now includes the same flag, so reruns preserve operator intent.

## Operator Impact

If the final run intentionally uses external artifact references, pass the flag on the last evidence update too:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id no-email-user-create-bind \
  --status pass \
  --source manual-admin \
  --operator <operator> \
  --summary "<summary>" \
  --artifact artifacts/no-email-user-create-bind/admin-create-bind-result.png \
  --artifact artifacts/no-email-user-create-bind/account-linked-after-refresh.png \
  --admin-email-was-blank \
  --admin-created-local-user-id <local-user-id> \
  --admin-bound-dingtalk-external-id <dingtalk-external-id> \
  --admin-account-linked-after-refresh \
  --closeout-when-ready \
  --allow-external-artifact-refs
```

Default behavior remains stricter: external artifacts are rejected unless explicitly allowed.

## Out Of Scope

- No real 142/staging smoke was executed.
- This does not weaken secret scanning or artifact folder validation for normal in-workspace artifacts.
