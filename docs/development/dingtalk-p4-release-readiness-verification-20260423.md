# DingTalk P4 Release Readiness Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-release-readiness-20260423`

## Commands Run

```bash
node --test scripts/ops/dingtalk-p4-release-readiness.test.mjs

node --test \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs

node --test $(ls scripts/ops/*dingtalk-p4*.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs 2>/dev/null | sort)

node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --output-dir /tmp/dingtalk-p4-release-readiness-default \
  --allow-failures

git diff --check
```

## Results

- Release readiness tests: pass, 5 tests.
- Release readiness plus adjacent env/regression gate tests: pass, 13 tests.
- Full DingTalk P4 ops regression suite: pass, 95 tests.
- Default release readiness dry run: expected fail because private env is still a placeholder; env gate failed and ops regression passed.
- `git diff --check`: pass.

## Covered Cases

- Env readiness failure blocks release readiness even when local regression passes.
- Complete env plus passing regression returns `overallStatus: "pass"` and prints the final smoke command.
- Regression plan-only mode returns `overallStatus: "manual_pending"`.
- `--allow-failures` exits zero while preserving a failed summary for report collection.
- Invalid public regression profiles are rejected.
- Secret-like child output and summaries are redacted.

## Real External Dependency Status

- Real 142/staging DingTalk P4 smoke was not executed.
- Current local private env remains a placeholder template unless the operator fills:
  - admin/table-owner bearer token
  - two DingTalk robot webhooks
  - at least one allowed local user or member group
  - unauthorized DingTalk-bound local user
  - no-email DingTalk external account target
