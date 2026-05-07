# DingTalk Group Failure Alert Probe Alert Subject Config - Development & Verification

Date: 2026-05-07

## Goal

Make the deployment probe tolerant to future creator-alert subject wording
changes. The default subject matcher remains unchanged, but operators can now
override it without editing code when validating an environment that uses a
custom or localized DingTalk work-notification subject.

## Development

- Added `--alert-subject <text>` to `scripts/ops/dingtalk-group-failure-alert-probe.mjs`.
- Added environment fallback `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`.
- Kept the default subject matcher as `MetaSheet DingTalk group delivery failed`.
- Creator alert detection now uses the configured subject matcher for:
  - latest creator alert lookup;
  - total creator alert count;
  - record-scoped creator alert count.
- Probe summaries now include `expectations.alertSubject`.
- `summary.md` now includes the subject matcher used for the run.
- Added regression coverage proving a custom subject can pass `--acceptance`.
- Added regression coverage proving `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT` is
  honored as an environment fallback.
- Added regression coverage proving unrelated person notifications do not
  satisfy creator-alert acceptance when the configured subject does not match.

## Files Changed

- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `docs/development/dingtalk-group-failure-alert-probe-alert-subject-config-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-enabled-rule-guard-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`

## Verification

Probe syntax and unit test:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

## Acceptance Impact

- Existing deployments keep the same default subject matching behavior.
- If the creator failure-alert subject is customized, rerun the probe with
  `--alert-subject "<subject text>"` instead of changing source code.
- The same override can be provided as `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`
  for scripted runs.
- Unrelated person delivery rows no longer satisfy creator-alert checks unless
  their subject includes the configured matcher.
- The configured subject matcher is visible in both JSON and Markdown evidence.
