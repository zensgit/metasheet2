# DingTalk Person Granted Form Route Success Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-granted-form-guard-20260422`
- Scope: backend route-level integration and public form submit guard coverage

## Context

Group automation creation already had route-level coverage for public forms protected by `accessMode: dingtalk_granted`. The next missing product paths were direct DingTalk person delivery, V1 `actions[]` delivery, and the submit-time security guard: a rule sends a message to selected local users, those users are bound to DingTalk, and the linked form still rejects bound users who have not been granted access.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `POST /api/multitable/sheets/:sheetId/automations` success case:

- Adds a granted public form fixture with `publicForm.accessMode: dingtalk_granted` and `allowedUserIds`.
- Creates a top-level `send_dingtalk_person_message` rule referencing the granted form and an internal processing view.
- Verifies the route persists the selected `userIds`.
- Verifies legacy `title` and `content` are normalized to `titleTemplate` and `bodyTemplate`.
- Verifies route-level link validation queries `meta_views`.

Added a second automation route success case for V1 `actions[]`:

- Creates a `notify` rule containing `actions: [{ type: 'send_dingtalk_person_message' }]`.
- References the same `dingtalk_granted` form view and internal processing view.
- Verifies normalized templates and view ids are persisted inside `actions[].config`.

Updated `packages/core-backend/tests/integration/public-form-flow.test.ts` with one `POST /api/multitable/views/:viewId/submit` denial case:

- Uses `accessMode: dingtalk_granted` with an authenticated, DingTalk-bound user.
- Leaves `hasDingTalkGrant` false.
- Verifies the submit route returns `DINGTALK_GRANT_REQUIRED`.
- Verifies the rejected submit does not execute `INSERT INTO meta_records`.

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

The backend route contract now covers the intended direct-person flow, the V1 multi-action flow, and the submit guard: a table owner can configure an automation that sends a DingTalk message to selected users, while the linked form remains restricted to users with the required DingTalk grant.
