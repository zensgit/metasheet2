# DingTalk P4 Unauthorized Denial Contract Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-unauthorized-denial-contract-20260423`

## Commands

```bash
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --check scripts/ops/dingtalk-p4-evidence-record.mjs
node --check scripts/ops/dingtalk-p4-evidence-record.test.mjs
node --check scripts/ops/dingtalk-p4-offline-handoff.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs
node --test scripts/ops/dingtalk-p4-offline-handoff.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/dingtalk-p4-final-handoff.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
git diff --check
```

## Expected Results

- Strict compile rejects `unauthorized-user-denied` pass evidence when `submitBlocked`, zero insert delta, or visible blocked reason is missing.
- Recorder accepts `--record-insert-delta 0` and equal before/after count variants.
- Recorder rejects incomplete unauthorized denial pass evidence before mutating `evidence.json`.
- Offline handoff remains release-ready with structured unauthorized denial evidence.

## Actual Results

- Syntax checks passed for the updated evidence compiler, recorder, and P4 session/handoff tests.
- `node --test` passed 56 tests with 0 failures across the P4 evidence compiler, recorder, offline handoff, smoke session, final handoff, smoke status, and staging packet validator suites.
- `git diff --check` passed.
