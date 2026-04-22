# DingTalk P4 API Smoke Runner Development

- Date: 2026-04-22
- Scope: P4 remote-smoke automation bootstrap
- Branch: `codex/dingtalk-p4-api-smoke-runner-20260422`

## What Changed

- Added `scripts/ops/dingtalk-p4-remote-smoke.mjs`.
- The runner creates a disposable base, sheet, text field, form view, and `dingtalk_granted` form-share allowlist.
- The runner creates two sheet-scoped DingTalk group destinations, runs test-send, creates a group automation with `publicFormViewId`, test-runs the automation, and queries rule-level group delivery rows.
- Optional `--person-user` creates and test-runs a DingTalk person automation, then queries rule-level person delivery rows.
- The output is `evidence.json`, aligned with `compile-dingtalk-p4-smoke-evidence.mjs`.
- Secrets are not printed or written: bearer tokens, DingTalk `access_token`, `sign`, `timestamp`, `SEC...`, JWTs, public form tokens, and password-like fields are redacted.

## Boundary

The runner is API-only. It does not replace these manual checks:

- real DingTalk group receives the visible message
- authorized DingTalk-bound user opens and submits the form from DingTalk
- unauthorized DingTalk-bound user is blocked and inserts no record
- no-email synced account is manually created and bound from the admin surface

Those checks remain `pending` in `evidence.json` until an operator fills manual evidence and compiles with `--strict`.

## Files

- `scripts/ops/dingtalk-p4-remote-smoke.mjs`
- `scripts/ops/dingtalk-p4-remote-smoke.test.mjs`
- `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`
- `scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

1. Provide `DINGTALK_P4_AUTH_TOKEN`, two group robot webhooks, and at least one allowed local user or member group on the staging host.
2. Run `node scripts/ops/dingtalk-p4-remote-smoke.mjs --output-dir output/dingtalk-p4-remote-smoke/<run>`.
3. Complete the manual DingTalk-client checks in the generated `evidence.json`.
4. Run `node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --input <evidence.json> --output-dir <run> --strict`.
