# DingTalk Group Failure Alert 142 Probe - Development & Verification

Date: 2026-05-07

## Goal

Add a deployment-side probe for the DingTalk group robot failure-alert feature.
The probe should let operators validate a deployed environment without sending
new DingTalk messages or exposing secrets.

## Development

- Added `scripts/ops/dingtalk-group-failure-alert-probe.mjs`.
- The probe reads deployed backend APIs only:
  - `GET /api/auth/me`
  - `GET /api/multitable/sheets/:sheetId/automations`
  - `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries`
  - `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-person-deliveries`
- The probe validates:
  - selected rule is a DingTalk group automation rule;
  - `notifyRuleCreatorOnFailure` is enabled, disabled, or either depending on `--expect-alert`;
  - recent group delivery history contains a failed delivery when `--require-group-failure` or `--acceptance` is used;
  - recent person delivery history contains a creator failure alert when `--require-person-alert` or `--acceptance` is used;
  - creator alert status matches `success`, `skipped`, `failed`, `none`, or `any` depending on `--expect-person-status`.
- The creator-alert subject matcher defaults to `MetaSheet DingTalk group delivery failed`
  and can be overridden with `--alert-subject`.
- The probe blocks acceptance when the selected automation rule is disabled,
  even if old delivery evidence exists.
- The probe writes redaction-safe outputs:
  - `summary.json`
  - `summary.md`
- Fatal startup and runtime failures now also write redaction-safe summaries
  when an output directory can be resolved, including missing token file,
  omitted auth token, omitted sheet id, expired/invalid auth token, missing rule
  id, no group rule, multiple group rules without `--rule-id`, 403/404 API
  failures, request timeouts, and network reachability failures.
- The probe supports `--auth-token-file` so operators can use local token files without printing tokens in shell history or logs.
- Added `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs` with a local HTTP server fixture.
- Added a backend runtime regression test for the linked-creator but failed DingTalk work-notification branch.
- Added `--record-id` support so explicit opt-out acceptance can ignore older creator-alert rows from previous records.
- Added `--skip-auth-me` coverage for deployments where `/api/auth/me` is
  intentionally skipped while the automation and delivery APIs are still
  checked with the bearer token.
- Added rule-selection diagnostics so `MULTIPLE_GROUP_RULES`,
  `RULE_NOT_FOUND`, and `NO_GROUP_RULE` summaries include safe rule ids/names
  that operators can use for the next rerun.
- Added HTTP failure diagnostics so deployed API blockers include the failing
  API path and redacted response body in `summary.json`/`summary.md`.
- Added timeout and network diagnostics so blocked summaries identify the
  failing API path, timeout value, or original fetch failure class.
- `--record-id` is now sent to delivery history APIs as a query parameter, so
  backend filtering happens before the history `limit` is applied.

## Example

```bash
node scripts/ops/dingtalk-group-failure-alert-probe.mjs \
  --api-base "http://142.171.239.56:8081" \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --sheet-id "<sheet-id>" \
  --rule-id "<automation-rule-id>" \
  --record-id "<current-test-record-id>" \
  --acceptance \
  --expect-person-status success \
  --output-dir "output/dingtalk-group-failure-alert-probe/142-acceptance"
```

Use `--expect-person-status skipped` for the unlinked-creator scenario.
Use `--expect-alert disabled --expect-person-status none --record-id <current-test-record-id>` for the explicit opt-out scenario.

## Files Changed

- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `apps/web/src/multitable/api/client.ts`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-enabled-rule-guard-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-alert-subject-config-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md`

## Verification

Targeted probe test:

```bash
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Covered cases:

- deployed acceptance snapshot passes with alert enabled, one failed group delivery, and one successful creator alert;
- custom creator-alert subject matching passes acceptance with `--alert-subject`;
- custom creator-alert subject matching also works from `DINGTALK_GROUP_FAILURE_ALERT_SUBJECT`;
- unrelated person notifications do not satisfy creator-alert acceptance when the subject matcher does not match;
- token-file input is used for Authorization but is not printed or written to `summary.md`;
- a selected rule with `notifyRuleCreatorOnFailure: false` fails the default enabled expectation;
- a disabled selected rule returns `RULE_DISABLED` even when group and creator alert evidence exists;
- explicit opt-out acceptance can be scoped to a current `recordId` and ignore older creator alerts from other records;
- record-scoped probe runs send `recordId` to both delivery history APIs;
- `--acceptance` fails when delivery evidence has not been produced yet.
- expired/invalid auth returns `AUTH_FAILED` and still writes `summary.json`/`summary.md`;
- missing token file returns `AUTH_TOKEN_FILE_NOT_FOUND` and still writes evidence;
- omitted token returns `AUTH_TOKEN_REQUIRED` and still writes evidence;
- omitted sheet id returns `SHEET_ID_REQUIRED` and still writes evidence;
- invalid argument values return `INVALID_ARGUMENTS` and still write evidence;
- deployed API 404 failures return `API_NOT_FOUND` with the failing API path;
- deployed API timeout failures return `API_TIMEOUT` with the failing API path and timeout value;
- deployed network reachability failures return `API_NETWORK_ERROR` with the failing API path;
- multiple group rules without `--rule-id` returns `MULTIPLE_GROUP_RULES` and still writes candidate rule evidence;
- a requested but missing `--rule-id` returns `RULE_NOT_FOUND` and still writes available group rule evidence;
- a sheet with no group rules returns `NO_GROUP_RULE` and still writes safe rule inventory evidence;
- `--skip-auth-me` avoids `/api/auth/me` and records `auth.checked = false`.

Targeted backend automation test:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

Additional coverage:

- linked creator exists and is active;
- group robot delivery fails first;
- DingTalk work-notification API returns a business error;
- automation output contains `failureAlert.status = failed`;
- `dingtalk_person_deliveries` stores a failed creator-alert audit row.

Targeted delivery route and service tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/multitable-automation-service.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false
```

Result: passed, 44 tests.

Frontend API client regression:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts --watch=false
```

Result: passed, 22 tests.

Scoped diff check:

```bash
git diff --check -- scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs packages/core-backend/tests/unit/automation-v1.test.ts docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: passed.

Secret scan:

```bash
rg -l "SEC[A-Za-z0-9]{20,}|access_token=[0-9a-f]{20,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=[0-9a-f]|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs packages/core-backend/tests/unit/automation-v1.test.ts docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: no matches.

## Acceptance Notes

- The probe does not trigger automations. Operators still need to create or trigger the known failing group delivery first.
- `--acceptance` is intended after the failed group delivery has been produced.
- The output files are safe to attach to a deployment handoff packet because token, webhook, SEC, and JWT-like fields are redacted.
- If the token path, token value, sheet id, selected rule, backend timeout, or
  backend reachability is wrong, use the generated `summary.md` as blocked
  evidence instead of treating the probe run as missing.
