# DingTalk Final Remote Smoke Verification

Date: 2026-05-12

## Environment

- Target: 142 deployment
- Backend image: `ghcr.io/zensgit/metasheet2-backend:e40ac3f909a2c5cad5072bc0e75f351c89513d10`
- Web image: `ghcr.io/zensgit/metasheet2-web:e40ac3f909a2c5cad5072bc0e75f351c89513d10`
- Smoke session: `142-session-e40ac3f9-ddzz-20260512`

## Commands Run

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --env-file /tmp/dingtalk-p4-live-acceptance-tunnel-20260512.env \
  --no-email-dingtalk-external-id <redacted-ddzz-dingtalk-user-id> \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --timeout-ms 120000

node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --check-id send-group-message-form-link \
  --status pass \
  --source manual-client

node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --check-id authorized-user-submit \
  --status pass \
  --source manual-client

node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --check-id unauthorized-user-denied \
  --status pass \
  --source manual-client \
  --submit-blocked \
  --record-insert-delta 0

node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --check-id no-email-user-create-bind \
  --status pass \
  --source manual-admin \
  --admin-email-was-blank \
  --admin-bound-dingtalk-external-id <redacted-ddzz-dingtalk-user-id> \
  --admin-account-linked-after-refresh

node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --finalize output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-session-e40ac3f9-ddzz-20260512-final \
  --docs-output-dir docs/development \
  --date 20260512

node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session-e40ac3f9-ddzz-20260512 \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-session-e40ac3f9-ddzz-20260512-final/handoff-summary.json \
  --require-release-ready

node scripts/ops/validate-dingtalk-staging-evidence-packet.mjs \
  --packet-dir artifacts/dingtalk-staging-evidence-packet/142-session-e40ac3f9-ddzz-20260512-final \
  --output-json artifacts/dingtalk-staging-evidence-packet/142-session-e40ac3f9-ddzz-20260512-final/publish-check.recheck.json
```

## Runtime Verification

| Gate | Result |
| --- | --- |
| Backend `/api/health` | `200` |
| Web `/` | `200` |
| Unauthenticated `/api/auth/me` | `401` |
| Backend image tag | `e40ac3f909a2c5cad5072bc0e75f351c89513d10` |
| Web image tag | `e40ac3f909a2c5cad5072bc0e75f351c89513d10` |

## Smoke Verification Results

| Gate | Result |
| --- | --- |
| Required checks | `8/8 PASS` |
| Remaining checks | `0` |
| Final strict status | `PASS` |
| API bootstrap status | `PASS` |
| Remote client status | `PASS` |
| Smoke status | `release_ready` |
| Evidence packet publish check | `PASS` |
| Secret findings in generated closeout | `0` |

## Manual Evidence Summary

- A/B group robot cards were visible in DingTalk and included the protected form entry point.
- The authorized DingTalk-bound user opened the protected form and submitted successfully.
- The unauthorized DingTalk-bound user was denied by the selected users/member groups gate.
- The no-email `ddzz` local account was confirmed as active, email blank, DingTalk identity linked, and DingTalk auth grant enabled.

## Secret Scan

```bash
rg -n -P "(access_token=(?!<redacted>|\\.\\.\\.)[A-Za-z0-9._~+/=-]{16,}|SEC[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}|Bearer\\s+[A-Za-z0-9._-]{20,})" \
  docs/development/dingtalk-final-remote-smoke-development-20260512.md \
  docs/development/dingtalk-final-remote-smoke-verification-20260512.md
```

Result: no matches.

## Conclusion

The DingTalk P4 live acceptance path is release-ready for the 142 deployment. The runtime checks, strict smoke finalization, evidence packet validation, and docs-only secret scan all passed.
