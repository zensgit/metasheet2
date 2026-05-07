# DingTalk Group Failure Alert Probe Fatal Summary - Development & Verification

Date: 2026-05-07

## Goal

Make the deployment probe useful even when the 142 validation run is blocked
before normal delivery evidence can be read. Operators should still get
redaction-safe `summary.json` and `summary.md` files for argument, auth, API,
and rule selection failures.

## Development

- Added fatal error classification to `scripts/ops/dingtalk-group-failure-alert-probe.mjs`.
- Fatal failures now produce `status: BLOCKED` summaries instead of only
  printing stderr when an output directory can be resolved from arguments,
  environment, or the default output root.
- Added specific failure codes:
  - `AUTH_TOKEN_FILE_NOT_FOUND`
  - `AUTH_TOKEN_REQUIRED`
  - `SHEET_ID_REQUIRED`
  - `INVALID_ARGUMENTS`
  - `AUTH_FAILED`
  - `FORBIDDEN`
  - `API_NOT_FOUND`
  - `API_TIMEOUT`
  - `API_NETWORK_ERROR`
  - `RULE_NOT_FOUND`
  - `MULTIPLE_GROUP_RULES`
  - `NO_GROUP_RULE`
  - `PROBE_FATAL_ERROR`
- Added operator next actions for each fatal class.
- Added HTTP failure detail for deployed API blockers, including status,
  requested API path, and redacted response body.
- Added timeout and network failure detail for deployed reachability blockers,
  including requested API path, timeout value, and redacted original fetch error.
- Added redaction-safe rule inventory details for rule-selection blockers:
  - `MULTIPLE_GROUP_RULES` includes candidate group rule ids and names;
  - `RULE_NOT_FOUND` includes available DingTalk group rule ids and names;
  - `NO_GROUP_RULE` includes a safe summary of the sheet's current rules.
- Kept all summary output behind the existing redaction path, including token,
  webhook, `SEC...`, bearer, and JWT-like values.
- Added `--skip-auth-me` regression coverage so the probe can intentionally
  avoid `/api/auth/me` while still checking automation and delivery APIs.
- Added parameter-stage regression coverage for missing token file, omitted
  auth token, omitted sheet id, and invalid argument values.

## Files Changed

- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-enabled-rule-guard-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-alert-subject-config-development-verification-20260507.md`

## Verification

Syntax check:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
```

Result: passed.

Targeted probe test:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Covered fatal and operational cases:

- expired/invalid auth token returns `AUTH_FAILED` and still writes
  `summary.json` plus `summary.md`;
- missing token file returns `AUTH_TOKEN_FILE_NOT_FOUND` and still writes
  `summary.json` plus `summary.md`;
- omitted token returns `AUTH_TOKEN_REQUIRED` and still writes summary evidence;
- omitted sheet id returns `SHEET_ID_REQUIRED` and still writes summary evidence;
- invalid argument values return `INVALID_ARGUMENTS` and still write summary evidence;
- deployed API 404 failures return `API_NOT_FOUND` with the failing API path
  and redacted response body in summary evidence;
- deployed API timeout failures return `API_TIMEOUT` with the failing API path
  and timeout value in summary evidence;
- deployed network reachability failures return `API_NETWORK_ERROR` with the
  failing API path in summary evidence;
- multiple DingTalk group rules without `--rule-id` returns
  `MULTIPLE_GROUP_RULES` and still writes candidate group rules in summary evidence;
- explicitly requested but missing `--rule-id` returns `RULE_NOT_FOUND` and
  still writes available group rules in summary evidence;
- a sheet with no DingTalk group rules returns `NO_GROUP_RULE` and writes a
  safe rule inventory to summary evidence;
- `--skip-auth-me` does not request `/api/auth/me`, records
  `auth.checked = false`, and still passes acceptance when delivery evidence is
  present.

Scoped diff check:

```bash
git diff --check -- scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: passed.

Secret scan:

```bash
rg -l "SEC[A-Za-z0-9]{20,}|access_token=[0-9a-f]{20,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=[0-9a-f]|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: no matches.

## Operator Impact

- A failed probe run should now be treated as useful evidence when it writes
  `summary.md`.
- `AUTH_TOKEN_FILE_NOT_FOUND` means fix the local token file path first.
- `AUTH_TOKEN_REQUIRED` means provide `--auth-token-file` or `--auth-token`.
- `SHEET_ID_REQUIRED` means provide the multitable sheet id under test.
- `INVALID_ARGUMENTS` means fix the CLI option value shown in the failure.
- `AUTH_FAILED` means refresh the admin token first.
- `API_TIMEOUT` means the backend did not answer the selected API path before
  `--timeout-ms`; check reachability or rerun with a larger timeout.
- `API_NETWORK_ERROR` means the backend host/port was not reachable from the
  probe machine.
- `MULTIPLE_GROUP_RULES` means rerun with `--rule-id`.
- `RULE_NOT_FOUND` means the supplied rule does not belong to the selected
  sheet or has been removed.
- `NO_GROUP_RULE` means create or select a DingTalk group automation rule first.
