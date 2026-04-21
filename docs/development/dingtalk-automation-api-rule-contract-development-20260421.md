# DingTalk Automation API Rule Contract Development - 2026-04-21

## Background

The DingTalk automation editor now emits advanced V1 payloads with `actions`, `conditions`, and action-specific link configuration. The frontend manager needs the automation API to return a stable `AutomationRule` shape immediately after list/create, otherwise saved DingTalk group/person rules can be inserted into UI state as wrapped or snake_case objects.

## Scope

- Canonicalize backend automation rule responses from `/api/multitable/sheets/:sheetId/automations`.
- Preserve V1 `trigger`, `conditions`, and `actions` in create/list/update responses.
- Add frontend response normalization for old snake_case rows and wrapped `{ rule }` create envelopes.
- Add regression coverage for DingTalk V1 group action contract shape.

## Backend Changes

- Added `serializeAutomationRule()` in `packages/core-backend/src/routes/univer-meta.ts`.
- `GET /automations` now returns `rules` as frontend-ready camelCase objects.
- `POST /automations` now returns the serialized rule instead of a minimal legacy subset.
- `PATCH /automations/:ruleId` now returns the serialized updated rule.
- `POST /automations` now derives `actionType/actionConfig` from the first V1 action when legacy fields are omitted, keeping advanced editor payloads compatible.

## Frontend Changes

- Added automation rule normalization in `apps/web/src/multitable/api/client.ts`.
- `listAutomationRules()` now accepts either array-style payloads or `{ rules }` payloads and normalizes snake_case/camelCase fields.
- `createAutomationRule()` now unwraps `{ data: { rule } }` and returns the actual `AutomationRule`.
- Missing `enabled` defaults to `true` unless the API explicitly returns `false`.

## Tests Added

- Backend integration test for canonical camelCase automation rule response with V1 DingTalk group `actions`.
- Frontend client test for snake_case automation list normalization.
- Frontend client test for create-rule envelope unwrapping.

## Files Changed

- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/tests/multitable-client.spec.ts`

## Notes

- This PR is stacked on the DingTalk automation editor entry work. It is intentionally focused on API contract correctness, not adding new UI controls.
- `pnpm install --frozen-lockfile` produced tracked `node_modules` symlink changes under plugin/tool workspaces in this worktree. Those files are dependency artifacts and are intentionally excluded from the commit.

## Main-target delivery note

The source branch for this change was stacked on a non-`main` base. For final delivery, the single API-contract commit was cherry-picked onto `main` after the create-entry PR landed, so the PR contains only the route/client contract normalization and its focused tests/docs.
