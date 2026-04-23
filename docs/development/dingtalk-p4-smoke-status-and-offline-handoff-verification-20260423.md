# DingTalk P4 Smoke Status And Offline Handoff Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-smoke-status-report-20260423`

## Commands

```bash
node --check scripts/ops/dingtalk-p4-smoke-status.mjs
node --check scripts/ops/dingtalk-p4-smoke-status.test.mjs
node --check scripts/ops/dingtalk-p4-offline-handoff.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-status.test.mjs
node --test scripts/ops/dingtalk-p4-offline-handoff.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/dingtalk-p4-final-handoff.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-preflight.test.mjs
git diff --check
```

## Expected Results

- Status reporter tests cover manual-pending, handoff-pending, release-ready, failed operational step, strict manual evidence issue, and missing input cases.
- Offline handoff test covers API-only bootstrap with a fake API, programmatic manual evidence completion, strict finalization, final handoff packet validation, and `--require-release-ready`.
- Output summaries must not contain raw admin tokens, DingTalk robot access tokens, `SEC...` signing secrets, or public form tokens.
