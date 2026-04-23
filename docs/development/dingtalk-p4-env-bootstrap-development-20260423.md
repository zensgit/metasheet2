# DingTalk P4 Env Bootstrap Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-env-bootstrap-20260423`
- Scope: local ops tooling only; no DingTalk or staging calls.

## Completed Work

- Added `scripts/ops/dingtalk-p4-env-bootstrap.mjs`.
- The script creates a private env template outside git by default:
  - `$HOME/.config/yuantus/dingtalk-p4-staging.env`
  - file mode `0600` on POSIX systems
  - no raw token, webhook, or SEC values in the generated template
- Added a `--check` mode that writes redacted readiness reports:
  - `readiness-summary.json`
  - `readiness-summary.md`
- The readiness check validates:
  - private env file permissions
  - API and web base URL presence/shape
  - admin bearer token presence
  - two DingTalk robot webhook presence/shape
  - optional SEC secret shape
  - local allowlist presence
  - final manual targets for authorized submit, unauthorized denial, and no-email admin validation
- The report emits next commands for:
  - `dingtalk-p4-smoke-preflight.mjs --require-manual-targets`
  - `dingtalk-p4-smoke-session.mjs --require-manual-targets`

## Design Notes

- The helper deliberately does not call the remote API or DingTalk. Its job is to make missing private inputs explicit before real smoke starts.
- The script treats the env file as secret-bearing and fails readiness if it is group/world readable.
- `DINGTALK_P4_AUTHORIZED_USER_ID` can be omitted when `DINGTALK_P4_ALLOWED_USER_IDS` contains at least one user; the first allowed user becomes the suggested authorized manual target.
- Bearer tokens, DingTalk robot access tokens, SEC secrets, timestamps, signs, JWTs, and public form tokens are redacted from all generated readiness reports.

## Operator Flow

```bash
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --init
```

Fill `$HOME/.config/yuantus/dingtalk-p4-staging.env` outside git, then run:

```bash
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --check
```

Only after readiness is `pass`, run the real P4 session:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --require-manual-targets \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

## Out Of Scope

- No remote DingTalk call.
- No 142/staging API mutation.
- No credential generation.
- No automatic creation of DingTalk-bound users or robot webhooks.
