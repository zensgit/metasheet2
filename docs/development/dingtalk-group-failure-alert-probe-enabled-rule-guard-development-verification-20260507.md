# DingTalk Group Failure Alert Probe Enabled Rule Guard - Development & Verification

Date: 2026-05-07

## Goal

Prevent a disabled DingTalk group automation rule from passing deployment
acceptance only because old delivery history still exists. The probe should
treat a disabled selected rule as blocked evidence and point the operator to
enable the rule or choose another enabled rule.

## Development

- Added `RULE_DISABLED` to `scripts/ops/dingtalk-group-failure-alert-probe.mjs`.
- The selected rule now blocks the probe when `rule.enabled !== true`.
- The blocked summary keeps `rule.enabled` and includes redaction-safe failure
  detail `{ enabled: false }` when the rule is disabled.
- Added operator next action: enable the selected rule or choose an enabled rule.
- Added regression coverage where:
  - the selected rule is disabled;
  - group failure evidence exists;
  - creator alert evidence exists;
  - `--acceptance` still exits non-zero with only `RULE_DISABLED`.

## Files Changed

- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `docs/development/dingtalk-group-failure-alert-probe-enabled-rule-guard-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`

## Verification

Probe syntax and unit test:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Backend automation regression:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

## Acceptance Impact

- A disabled selected rule now produces `status: BLOCKED`.
- The probe no longer treats historical group/person delivery rows as enough
  acceptance evidence when the rule cannot currently run.
- Operators get a concrete next action in `summary.md`.
