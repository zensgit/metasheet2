# DingTalk P4 Final Input Gates Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Result: pass

## Commands Run

```bash
node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs
```

- Result: pass, 34 tests.

## Covered Cases

- Env readiness fails when `DINGTALK_P4_PERSON_USER_IDS` is missing.
- Preflight fails missing person user only when `--require-person-user` is enabled.
- Smoke session always enables the final person-user preflight gate and stops before workspace bootstrap when the value is missing.
- Smoke session help and env template show canonical robot webhook shape.
- Release-readiness strips parent `DINGTALK_P4_*` smoke input env vars before launching `smoke-session`, so the checked env file is used.
- Release-readiness fails if the smoke child exits 0 without writing a valid `session-summary.json`.

## Full Regression

Run after this document was added:

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

- Result: pass, 121 tests.
