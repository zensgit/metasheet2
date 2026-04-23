# DingTalk P4 Manual Target Readiness Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-release-gate-20260423`

## Commands Run

```bash
node --test \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs

node --test \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs

git diff --check
```

## Results

- Targeted preflight/remote-smoke/session tests: pass, 15 tests.
- Full P4 ops regression suite: pass, 70 tests.
- `git diff --check`: pass.

## Covered Cases

- Preflight passes with declared authorized, unauthorized, and no-email targets and writes them to the redacted summary.
- `--require-manual-targets` fails preflight when mandatory manual targets are missing.
- Remote smoke writes manual targets to `evidence.json` and the manual evidence checklist.
- Smoke session env template includes the new target variables and passes them through child tools.

## Broader Gates

- Product/backend/frontend integration and build gates were not rerun in this local slice because the change is limited to local P4 ops scripts and documentation.
