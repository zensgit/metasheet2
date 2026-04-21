# DingTalk Group Destination Sharing Review Hardening Development

## Date
- 2026-04-20

## Goal
- Address concrete review comments on `#936` without expanding the feature scope.

## Changes

### Backend
- Updated `packages/core-backend/src/routes/api-tokens.ts`
  - `CreateDingTalkGroupSchema` now includes optional `sheetId`
  - create route reads `sheetId` from parsed `input` instead of raw `req.body`
- Updated `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
  - `loadAuthorizedDestination()` now uses `row.sheet_id !== null`
  - avoids implicit empty-string fallback behavior

### Frontend
- Updated `apps/web/src/multitable/api/client.ts`
  - `updateDingTalkGroup(...)` now accepts `Partial<Omit<DingTalkGroupDestinationInput, 'sheetId'>>`
  - `sheetId` remains request context via query string, not PATCH body payload
- Updated `apps/web/src/multitable/components/MetaApiTokenManager.vue`
  - create still sends `sheetId` in body
  - update no longer includes `sheetId` in body

## Notes
- This slice intentionally keeps create semantics unchanged while removing ambiguous body/query duplication from update flows.
- No schema changes were added beyond the original `sheet_id` migration.
