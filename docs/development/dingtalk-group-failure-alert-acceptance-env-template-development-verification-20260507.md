# DingTalk Group Failure Alert Acceptance Env Template - Development & Verification

Date: 2026-05-07

## Goal

Make the final 142 live-acceptance inputs easier to collect without exposing
secrets. Operators can now generate a private fill-in env file, fill the missing
sheet/rule/record values, and then run the existing acceptance-status helper.

## Development

- Extended `scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs`
  with `--write-env-template <file>`.
- Added `--force` for intentional overwrite.
- Existing template files are not overwritten by default.
- The generated template includes only comments, placeholders, safe defaults,
  and env key names:
  - `DINGTALK_GROUP_FAILURE_ALERT_API_BASE`
  - `DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE`
  - `DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN`
  - `DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID`
  - `DINGTALK_GROUP_FAILURE_ALERT_RULE_ID`
  - `DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID`
  - `DINGTALK_GROUP_FAILURE_ALERT_EXPECT_PERSON_STATUS`
  - `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`
  - `DINGTALK_GROUP_FAILURE_ALERT_PROBE_OUTPUT_DIR`
- Updated the acceptance-status helper docs, closeout doc, and final handoff doc
  to describe the template-first flow.

## Usage

```bash
node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs \
  --write-env-template output/dingtalk-group-failure-alert-acceptance/142.env
```

Fill the generated private file, then run:

```bash
node scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs \
  --env-file output/dingtalk-group-failure-alert-acceptance/142.env \
  --output-json output/dingtalk-group-failure-alert-acceptance-status/summary.json \
  --output-md output/dingtalk-group-failure-alert-acceptance-status/summary.md \
  --allow-blocked
```

## Verification

Syntax:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-acceptance-status.mjs
node --check scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs
```

Result: passed.

Acceptance-status helper tests:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs
```

Result: passed, 7 tests.

Combined helper + probe regression tests:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-acceptance-status.test.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 28 tests.

Documentation consistency scan:

```bash
rg -n "Result: passed, 5 tests|5 tests|20 tests|Result: passed, 20" docs/development/dingtalk-group-failure-alert*.md scripts/ops/dingtalk-group-failure-alert*.test.mjs
```

Result: no matches.

Secret scan:

```bash
rg -n "oapi\\.dingtalk\\.com/robot/send\\?access_token=[0-9a-fA-F]{32,}|access_token=[0-9a-fA-F]{32,}|SEC[0-9a-fA-F]{32,}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}" scripts/ops/dingtalk-group-failure-alert*.mjs docs/development/dingtalk-group-failure-alert*.md packages/core-backend/src/multitable packages/core-backend/src/routes/univer-meta.ts apps/web/src/multitable
```

Result: no matches.

Whitespace scan:

```bash
rg -n "[ \\t]$" scripts/ops/dingtalk-group-failure-alert*.mjs docs/development/dingtalk-group-failure-alert*.md
```

Result: no matches.

## Acceptance Impact

This removes another manual handoff gap: the operator no longer needs to infer
where to place the live 142 acceptance inputs. The generated env file remains
private and should not be committed after it is filled with real values.
