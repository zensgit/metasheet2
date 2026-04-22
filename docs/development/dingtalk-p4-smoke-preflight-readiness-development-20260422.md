# DingTalk P4 Smoke Preflight And Readiness Development

- Date: 2026-04-22
- Scope: P4 remote-smoke execution readiness
- Branch: `codex/dingtalk-p4-smoke-preflight-20260422`

## What Changed

- Added `scripts/ops/dingtalk-p4-smoke-preflight.mjs`.
- The preflight checks local smoke tooling, API/web base URLs, bearer token presence, DingTalk group webhook format, optional `SEC...` secret format, allowlist inputs, optional person recipients, and backend `/health`.
- The preflight writes `preflight-summary.json` and `preflight-summary.md` without persisting raw tokens, webhook access tokens, signatures, timestamps, or robot secrets.
- Hardened `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs` strict mode so API-only evidence cannot be mislabeled as full remote smoke.
- `send-group-message-form-link`, `authorized-user-submit`, and `unauthorized-user-denied` now require `source: "manual-client"` plus operator, timestamp, summary/notes, and per-check artifact refs when marked `pass`.
- `no-email-user-create-bind` now requires `source: "manual-admin"` plus the same metadata when marked `pass`.
- The evidence summary now reports both `apiBootstrapStatus` and `remoteClientStatus`.
- Updated the API runner so group automation API delivery evidence keeps `send-group-message-form-link` pending until real DingTalk-client visibility evidence is attached.

## Boundary

The new gate prevents accidental strict pass from incomplete evidence. It still cannot prove truthfulness of screenshots or operator-entered metadata. Real remote smoke still requires a DingTalk group, a bound authorized user, an unauthorized user, and an admin no-email account creation path.

## Files

- `scripts/ops/dingtalk-p4-smoke-preflight.mjs`
- `scripts/ops/dingtalk-p4-smoke-preflight.test.mjs`
- `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`
- `scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs`
- `scripts/ops/dingtalk-p4-remote-smoke.mjs`
- `scripts/ops/dingtalk-p4-remote-smoke.test.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

1. Run `node scripts/ops/dingtalk-p4-smoke-preflight.mjs --output-dir output/dingtalk-p4-remote-smoke/preflight-<env>`.
2. Fix any preflight failure before calling the API runner.
3. Run `node scripts/ops/dingtalk-p4-remote-smoke.mjs --output-dir output/dingtalk-p4-remote-smoke/<run>`.
4. Attach manual DingTalk-client/admin evidence to `evidence.json`.
5. Compile with `node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --input <evidence.json> --output-dir <run> --strict`.
