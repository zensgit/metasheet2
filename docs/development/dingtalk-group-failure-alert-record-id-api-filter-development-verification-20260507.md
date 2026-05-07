# DingTalk Group Failure Alert RecordId API Filter - Development & Verification

Date: 2026-05-07

## Goal

Make record-scoped DingTalk group failure-alert acceptance deterministic on busy
rules. When the probe is run with `--record-id`, the backend delivery history
APIs should filter by `recordId` before applying `limit`, instead of returning
recent history and relying only on local probe filtering.

## Development

- Added optional `recordId` filtering to `listAutomationDingTalkGroupDeliveries`.
- Added optional `recordId` filtering to `listAutomationDingTalkPersonDeliveries`.
- Added `parseDingTalkAutomationDeliveryRecordId` for route query parsing.
- Updated delivery history routes to pass `recordId` into the service layer:
  - `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries`
  - `GET /api/multitable/sheets/:sheetId/automations/:ruleId/dingtalk-person-deliveries`
- Updated frontend API client delivery-history methods to accept optional
  `recordId`; existing callers remain compatible because the new parameter is
  optional.
- Updated the deployment probe so `--record-id` is sent as a delivery API query
  parameter for both group and person delivery reads.

## Files Changed

- `packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts`
- `packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/dingtalk-group-delivery-service.test.ts`
- `packages/core-backend/tests/unit/dingtalk-person-delivery-service.test.ts`
- `packages/core-backend/tests/unit/multitable-automation-service.test.ts`
- `packages/core-backend/tests/integration/dingtalk-delivery-routes.api.test.ts`
- `apps/web/src/multitable/api/client.ts`
- `scripts/ops/dingtalk-group-failure-alert-probe.mjs`
- `scripts/ops/dingtalk-group-failure-alert-probe.test.mjs`
- `docs/development/dingtalk-group-failure-alert-record-id-api-filter-development-verification-20260507.md`

## Verification

Probe syntax and unit test:

```bash
node --check scripts/ops/dingtalk-group-failure-alert-probe.mjs
node --test scripts/ops/dingtalk-group-failure-alert-probe.test.mjs
```

Result: passed, 21 tests.

Backend targeted delivery and route tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-delivery-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/multitable-automation-service.test.ts tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false
```

Result: passed, 44 tests.

Backend automation regression:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 143 tests.

Frontend API client regression:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts --watch=false
```

Result: passed, 22 tests.

Backend type check:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed.

## Acceptance Impact

- `--record-id` now narrows delivery history at the backend query layer.
- High-frequency rules are less likely to produce false `GROUP_FAILURE_NOT_FOUND`
  or `CREATOR_ALERT_NOT_FOUND` when the target record is older than the default
  history window.
- Existing UI calls without `recordId` keep their previous behavior.
