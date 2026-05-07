# DingTalk Group Failure Alert Acceptance Status Helper - Development & Verification

Date: 2026-05-07

## Goal

Reduce the remaining 142 live-acceptance risk for DingTalk group robot failure
alerts by adding a local input/status helper. The helper checks whether the
operator has enough private inputs to run the deployment probe, without calling
142, calling DingTalk, triggering automations, or writing secrets.

## Development

- Added `scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs`.
- Added `scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs`.
- Added `--write-env-template <file>` so operators can generate a fill-in
  private env file for the 142 acceptance inputs.
- Added `--force` for intentional template overwrite; existing template files
  are not overwritten by default.
- The helper reads inputs from CLI args, environment variables, and an optional
  env file.
- Required live-acceptance inputs are checked:
  - API base URL;
  - admin token or admin token file;
  - readable token file when a file path is provided;
  - sheet id;
  - automation rule id;
  - fresh failed test record id;
  - expected creator person delivery status;
  - creator-alert subject matcher.
- The helper writes:
  - redaction-safe `summary.json`;
  - redaction-safe `summary.md`;
  - `ready` or `blocked` status;
  - actionable missing-input remediation;
  - generated probe commands for the enabled-alert and explicit opt-out
    acceptance scenarios.
- CLI values override env-file and process-env values, so operators can correct
  one field without rewriting their private env file.
- Token values are never written; output only records token presence and token
  file path/readability.
- The generated env template contains only placeholders/defaults and no real
  token, webhook, robot secret, or JWT value.

## Usage

Generate a fill-in template:

```bash
node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs \
  --write-env-template output/dingtalk-group-failure-alert-acceptance/142.env
```

Fill the generated file locally, then check the current status:

```bash
node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs \
  --env-file output/dingtalk-group-failure-alert-acceptance/142.env \
  --output-json output/dingtalk-group-failure-alert-acceptance-status/summary.json \
  --output-md output/dingtalk-group-failure-alert-acceptance-status/summary.md \
  --allow-blocked
```

Once the helper reports `ready`, copy the generated probe command from
`summary.md` and run it after producing a fresh failed group robot delivery.

## Verification

Syntax:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs
```

Result: passed.

Acceptance-status helper tests:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs
```

Result: passed, 7 tests.

Regression probe tests:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Coverage includes:

- blocked summary generation without leaking token values;
- env template generation without secrets;
- overwrite protection unless `--force` is passed;
- ready summary generation with enabled-alert and opt-out probe commands;
- CLI values overriding env-file values;
- unreadable token file blocker;
- non-zero exit when blocked unless `--allow-blocked` is passed.

## Acceptance Impact

This does not replace the live deployment probe. It makes the step before the
probe deterministic, so operators can see exactly which live-only inputs are
missing before triggering a real failed group robot delivery.
