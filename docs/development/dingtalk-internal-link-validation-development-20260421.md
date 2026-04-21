# DingTalk Internal Link Validation Development 2026-04-21

## Scope

This change hardens DingTalk automation internal processing links. Public form links already had front-end and runtime guardrails; internal links now receive the same current-sheet existence checks before save and at runtime.

## Changes

- Added `apps/web/src/multitable/utils/dingtalkInternalViewLinkWarnings.ts`.
- `MetaAutomationRuleEditor.vue` now:
  - filters internal processing view choices to the current sheet
  - shows a warning when a saved `internalViewId` no longer exists in the current sheet
  - disables save for DingTalk group/person actions with missing internal processing views
- `MetaAutomationManager.vue` now applies the same current-sheet filtering and warning behavior in inline automation forms.
- `packages/core-backend/src/routes/univer-meta.ts` now rejects automation create/update payloads when DingTalk group/person `internalViewId` values do not exist in the target sheet.
- `packages/core-backend/tests/unit/automation-v1.test.ts` now covers the existing runtime guardrail for group and person DingTalk delivery.
- Existing runtime delivery still refuses missing internal views before sending DingTalk messages.

## Design Notes

- This does not restrict `internalViewId` to a specific view type; it only requires the view to exist in the same sheet.
- Save-time validation covers both legacy single-action fields (`actionType` / `actionConfig`) and multi-action `actions[]`.
- PATCH validation merges submitted fields with the existing rule when needed so partial updates cannot introduce or retain invalid DingTalk internal links.
- The automation payload schema is unchanged.
