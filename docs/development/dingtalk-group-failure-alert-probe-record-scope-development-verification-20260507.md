# DingTalk Group Failure Alert Probe Record Scope - Development & Verification

Date: 2026-05-07

## Goal

Harden the 142 deployment probe for explicit opt-out acceptance. A single
automation rule may already have older creator-alert delivery rows from earlier
enabled runs, so the probe needs a way to validate only the current test record.

## Development

- Added `--record-id <id>` to `scripts/ops/dingtalk-group-failure-alert-probe.mjs`.
- Added `DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID` and `RECORD_ID` environment fallbacks.
- Scoped the latest failed group delivery and creator-alert lookup to the record id when provided.
- Added summary fields:
  - `expectations.recordId`
  - `groupDeliveries.matchingFailedCount`
  - `personDeliveries.matchingCreatorAlertCount`
- Kept total counts in the summary so old history remains visible while current-record acceptance stays deterministic.
- Added backend delivery API `recordId` query filtering so record-scoped checks
  are filtered before `limit` is applied.
- Updated the probe to pass `recordId` to group and person delivery history APIs.
- Added a regression test where:
  - the selected rule is explicitly disabled with `notifyRuleCreatorOnFailure: false`;
  - the current record has a failed group delivery;
  - an older different record still has a creator alert;
  - `--record-id <current>` plus `--expect-person-status none` passes.

## Files Changed

- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `apps/web/src/multitable/api/client.ts`
- `docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-probe-reachability-diagnostics-development-verification-20260507.md`
- `docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md`
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
- a disabled selected rule returns `RULE_DISABLED` even when historical delivery evidence exists;
- explicit disabled acceptance can be scoped to a current `recordId` and ignores older creator alerts from other records;
- record-scoped probe runs send `recordId` to both delivery history APIs;
- `--acceptance` fails when delivery evidence has not been produced yet.
- auth, missing-rule, and ambiguous-rule fatal paths still write redaction-safe summary evidence;
- rule-selection blockers include safe rule ids/names to make the next 142 rerun executable;
- missing-token-file, omitted-token, and omitted-sheet-id startup failures still write redaction-safe summary evidence;
- invalid arguments and deployed API 404/timeout/network failures still write redaction-safe summary evidence with actionable detail;
- `--skip-auth-me` avoids `/api/auth/me` while still checking rule and delivery APIs.

Targeted backend record-filter tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/multitable-automation-service.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false
```

Result: passed, 44 tests.

Scoped diff check:

```bash
git diff --check -- scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: passed.

Secret scan:

```bash
rg -l "SEC[A-Za-z0-9]{20,}|access_token=[0-9a-f]{20,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=[0-9a-f]|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" scripts/ops/dingtalk-group-failure-alert-probe.mjs scripts/ops/dingtalk-group-failure-alert-probe.test.mjs docs/development/dingtalk-group-failure-alert-probe-record-scope-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-probe-fatal-summary-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-142-probe-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-to-rule-creator-development-verification-20260507.md docs/development/dingtalk-group-failure-alert-final-handoff-20260507.md
```

Result: no matches.

## 142 Usage

For enabled creator-alert acceptance:

```bash
node scripts/ops/dingtalk-group-failure-alert-probe.mjs \
  --api-base "http://142.171.239.56:8081" \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --sheet-id "<sheet-id>" \
  --rule-id "<automation-rule-id>" \
  --record-id "<current-test-record-id>" \
  --acceptance \
  --expect-person-status success \
  --output-dir "output/dingtalk-group-failure-alert-probe/142-enabled"
```

For explicit opt-out acceptance:

```bash
node scripts/ops/dingtalk-group-failure-alert-probe.mjs \
  --api-base "http://142.171.239.56:8081" \
  --auth-token-file /tmp/metasheet-142-main-admin-72h.jwt \
  --sheet-id "<sheet-id>" \
  --rule-id "<automation-rule-id>" \
  --record-id "<current-test-record-id>" \
  --expect-alert disabled \
  --expect-person-status none \
  --require-group-failure \
  --output-dir "output/dingtalk-group-failure-alert-probe/142-disabled"
```
