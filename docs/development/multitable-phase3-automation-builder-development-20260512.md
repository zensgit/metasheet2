# Multitable Phase 3 Automation Builder Development

Date: 2026-05-12
Branch: `codex/multitable-phase3-automation-builder-20260512`
Base: `origin/main@e40ac3f90`

## Goal

Close the Phase 3 Automation Builder gap where nested automation condition groups were accepted by the backend but only preserved read-only in the frontend rule editor.

## Scope

- Add visual editing for nested condition groups in `MetaAutomationRuleEditor.vue`.
- Keep backend API, migrations, and OpenAPI unchanged because nested groups are already parsed and evaluated by `packages/core-backend/src/multitable/automation-conditions.ts`.
- Preserve existing top-level condition selectors and typed value widgets.

## Design

The editor now renders a flattened condition tree with path metadata:

- Leaf rows use `data-condition-path` and preserve `data-condition-index` compatibility for existing tests.
- Group rows use `data-condition-group-path`, show an `AND` / `OR` toggle, and expose add-condition, add-group, and remove actions.
- Root controls still support root-level `AND` / `OR`, add condition, and add group.

Condition payloads are canonicalized to `conjunction: 'AND' | 'OR'` when cloned and saved. This avoids emitting conflicting legacy `logic` plus current `conjunction` values after a user edits an existing nested group.

## Depth Guard

The backend allows condition groups through depth 5. The frontend mirrors that guard by disabling `+ Group` on a group whose path length is already 5, while still allowing leaf conditions inside that group.

## Validation Rules

- Empty root condition list is still valid because conditions are optional.
- Empty nested groups are invalid and keep Save disabled.
- Leaf validation keeps the existing field-aware behavior for numeric, boolean, list, date, select, and unary operators.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `docs/development/multitable-phase3-automation-builder-development-20260512.md`
- `docs/development/multitable-phase3-automation-builder-verification-20260512.md`

## Non-Goals

- No backend behavior change.
- No automation execution engine change.
- No staging run in this slice; this is a frontend builder and serialization improvement.
