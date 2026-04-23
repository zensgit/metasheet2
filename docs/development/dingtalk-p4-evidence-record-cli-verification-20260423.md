# DingTalk P4 Evidence Record CLI Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-evidence-record-cli-20260423`

## Commands

```bash
node --check scripts/ops/dingtalk-p4-evidence-record.mjs
node --check scripts/ops/dingtalk-p4-evidence-record.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-status.test.mjs
node --test scripts/ops/dingtalk-p4-offline-handoff.test.mjs
git diff --check
```

## Expected Results

- Recorder accepts valid manual pass evidence and writes `updatedBy: "dingtalk-p4-evidence-record"`.
- `--dry-run` validates and prints without mutating `evidence.json`.
- Wrong manual source, missing artifacts, wrong artifact folder, unknown check IDs, invalid statuses, missing evidence files, secret-like summaries, and secret-like text artifacts are rejected.
- Smoke-session next commands include the recorder for pending manual evidence.
- Exported evidence packets include the recorder script and README guidance.
