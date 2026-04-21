# DingTalk Form Link Save Validation Development 2026-04-21

## Scope

This change prevents saving DingTalk automation rules when the selected public form link cannot produce a working fill link.

## Changes

- Added `listDingTalkPublicFormLinkBlockingErrors()` in `apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts`.
- Reused the existing public-form validation path for hard errors:
  - selected view is missing from the current sheet
  - selected view is not a form view
  - public form sharing is not configured
  - public form sharing is disabled
  - public form sharing has no public token
  - public form sharing has expired
- `MetaAutomationRuleEditor.vue` now disables save for DingTalk group and person actions with blocking public-form link errors.
- `MetaAutomationManager.vue` now applies the same save gate in the inline create/edit form.
- Updated DingTalk admin and capability docs to document the save gate.
- Advisory warnings remain advisory:
  - fully public links in group messages
  - DingTalk-protected links without allowed users or member groups

## Design Notes

- The save gate uses a dedicated helper instead of matching warning strings.
- Existing visible warning text remains the user-facing explanation for why save is disabled.
- The backend runtime validation remains in place, so this is a front-end guardrail rather than the only enforcement layer.
- The automation payload schema is unchanged.
