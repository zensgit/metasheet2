# DingTalk Granted Form Route Success Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-granted-form-route-success-20260422`
- Scope: backend route-level integration coverage

## Context

Unit coverage already allows DingTalk-protected public forms, including `accessMode: dingtalk_granted`. The route integration suite only persisted automation rules that referenced default public forms. The missing route-level proof was that a DingTalk automation can be saved with a public form link that requires DingTalk authorization.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with one `POST /api/multitable/sheets/:sheetId/automations` success case:

- Adds a form view fixture with `publicForm.accessMode: dingtalk_granted`.
- Creates a top-level `send_dingtalk_group_message` rule referencing that granted form and an internal processing view.
- Verifies the route persists normalized `titleTemplate` and `bodyTemplate`.
- Verifies route-level link validation queries `meta_views`.

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

Automation setup can reference DingTalk-authorized public forms, supporting the intended flow where only authorized DingTalk-bound users can open and fill the form.
