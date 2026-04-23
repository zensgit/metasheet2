# DingTalk P4 Robot Webhook Contract Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Result: pass

## Commands Run

```bash
node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs
```

- Result: pass, 18 tests.

```bash
node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs
```

- Result: pass, 115 tests.

## Covered Cases

- Env readiness passes canonical robot URLs and rejects non-canonical scheme/path shapes.
- Preflight rejects non-HTTPS and non-DingTalk robot URLs while redacting webhook tokens.
- Remote smoke rejects invalid robot URLs before any API request is made.
- Remote smoke fake API now asserts group destination webhook URLs use HTTPS, `oapi.dingtalk.com`, `/robot/send`, and an `access_token`.
- Existing closeout, handoff, packet export/validation, evidence recorder, smoke session, smoke status, and strict compile flows still pass after the validation tightening.

## Remaining External Blockers

The real 142/staging run still requires operator-supplied private values outside git:

- admin/table-owner bearer token;
- two canonical DingTalk robot webhook URLs;
- optional `SEC...` signing secrets;
- allowed/person/manual DingTalk target IDs.
