# DingTalk P4 Strict Artifact Secret Scan Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-artifact-secret-scan-20260423`

## Commands

```bash
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --check scripts/ops/dingtalk-p4-offline-handoff.test.mjs
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/dingtalk-p4-offline-handoff.test.mjs
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs
node --test scripts/ops/dingtalk-p4-final-handoff.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
git diff --check
```

## Expected Results

- Passing evidence with clean artifacts still compiles successfully.
- Strict compile rejects local manual text artifacts containing DingTalk robot webhook tokens or `SEC...` secrets.
- `summary.json` and stderr must not contain raw secret values from artifact content.
- Session finalization and offline handoff remain green with clean artifacts.
