# DingTalk P4 Release Readiness Selftest Guard Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-release-readiness-selftest-guard-20260423`

## Commands Run

```bash
node --test scripts/ops/dingtalk-p4-release-readiness.test.mjs

node --test \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs

node --test $(ls scripts/ops/*dingtalk-p4*.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs 2>/dev/null | sort)

git diff --check
```

## Results

- Release-readiness tests: pass, 6 tests.
- Release-readiness plus regression-gate tests: pass, 10 tests.
- Full DingTalk P4 ops regression suite: pass, 96 tests.
- `git diff --check`: pass.

## Covered Cases

- `--regression-profile selftest` is rejected by default.
- The same profile can be used in tests only when `DINGTALK_P4_RELEASE_READINESS_ALLOW_SELFTEST=1` is set.
- Existing fail/pass/manual-pending/allow-failures release-readiness behavior remains covered.

## Real External Dependency Status

- Real 142/staging DingTalk P4 smoke was not executed.
- Current private env remains a placeholder until real token, robot webhooks, allowlist, and manual targets are filled.
