# Multitable Record Subscription OpenAPI Development

- Date: 2026-05-05
- Branch: `codex/multitable-record-subscriptions-openapi-20260505`
- Scope: contract-only follow-up for record subscription endpoints

## Context

Record subscriptions already had backend routes and frontend client methods:

- `GET /api/multitable/sheets/:sheetId/records/:recordId/subscriptions`
- `PUT /api/multitable/sheets/:sheetId/records/:recordId/subscriptions/me`
- `DELETE /api/multitable/sheets/:sheetId/records/:recordId/subscriptions/me`
- `GET /api/multitable/record-subscription-notifications`

The OpenAPI source did not describe those endpoints, so generated API artifacts and the multitable parity gate could drift behind runtime behavior.

## Implementation

Updated `packages/openapi/src/base.yml` with:

- `MultitableRecordSubscription`
- `MultitableRecordSubscriptionStatus`
- `MultitableRecordSubscriptionNotificationType`
- `MultitableRecordSubscriptionNotification`

Updated `packages/openapi/src/paths/multitable.yml` with the four subscription endpoints and their path/query parameters, authentication requirements, success payloads, and common error responses.

Updated `scripts/ops/multitable-openapi-parity.test.mjs` so the contract gate now fails if these paths or response schema refs disappear.

Generated OpenAPI dist artifacts with `packages/openapi/tools/build.ts`.

## Compatibility Notes

The status schema keeps optional `items` for compatibility with the current runtime shape, but marks it as legacy. The intended client contract is `subscribed` plus `subscription` for the current user, which also matches the privacy hardening follow-up in PR #1291.

