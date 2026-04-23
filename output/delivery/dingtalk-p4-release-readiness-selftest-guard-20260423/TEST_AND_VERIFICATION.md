# TEST AND VERIFICATION - DingTalk P4 Release Readiness Selftest Guard

## Summary

Hardened the DingTalk P4 release-readiness gate so test-only regression profiles cannot be used by default in operator runs.

The public CLI now only accepts `ops`, `product`, and `all`. Unit tests can still unlock `selftest` with `DINGTALK_P4_RELEASE_READINESS_ALLOW_SELFTEST=1`.

## Files

- `scripts/ops/dingtalk-p4-release-readiness.mjs`
- `scripts/ops/dingtalk-p4-release-readiness.test.mjs`
- `docs/development/dingtalk-p4-release-readiness-selftest-guard-development-20260423.md`
- `docs/development/dingtalk-p4-release-readiness-selftest-guard-verification-20260423.md`

## Verification

| Gate | Result |
| --- | --- |
| Release-readiness tests | 6/6 passed |
| Release-readiness + regression-gate tests | 10/10 passed |
| Full DingTalk P4 ops regression suite | 96/96 passed |
| `git diff --check` | passed |

## Commands

```bash
node --test scripts/ops/dingtalk-p4-release-readiness.test.mjs

node --test \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs

node --test $(ls scripts/ops/*dingtalk-p4*.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs 2>/dev/null | sort)

git diff --check
```

## Status

This is local gate hardening only. It does not run the real 142/staging smoke and does not touch private env values.
