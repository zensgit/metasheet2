# DingTalk P4 Release Readiness Selftest Guard Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-release-readiness-selftest-guard-20260423`
- Scope: local release-readiness gate hardening; no DingTalk or staging calls.

## Completed Work

- Restricted `scripts/ops/dingtalk-p4-release-readiness.mjs` so public operator runs only accept:
  - `ops`
  - `product`
  - `all`
- Kept test-only regression profiles available only when explicitly unlocked with:
  - `DINGTALK_P4_RELEASE_READINESS_ALLOW_SELFTEST=1`
- Updated release-readiness tests to use the explicit unlock when exercising `selftest`.
- Added coverage that proves `--regression-profile selftest` is rejected by default.

## Reasoning

The release-readiness gate decides whether an operator may start final 142/staging P4 smoke. Hidden selftest profiles are useful for fast unit tests, but they must not be accepted in normal operator runs because they can bypass real `ops/product/all` regression coverage.

This change keeps test speed while making the production CLI fail closed.

## Out Of Scope

- No product runtime change.
- No real remote smoke.
- No credential or env mutation.
