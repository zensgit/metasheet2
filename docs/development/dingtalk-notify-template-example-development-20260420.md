# DingTalk Notify Template Example Development 2026-04-20

## Goal

Add a rendered-example layer to DingTalk notification authoring so admins can see not only the raw title/body templates, but also a sample rendered result before saving the rule.

## Scope

- Frontend only
- No backend API changes
- No runtime protocol changes
- No database migrations

## Changes

### Shared example renderer

Added:

- `apps/web/src/multitable/utils/dingtalkNotificationTemplateExample.ts`

This utility provides:

- sample data for common notification tokens
- a simple renderer for `{{recordId}}`, `{{sheetId}}`, `{{actorId}}`, and `{{record.xxx}}` token paths

### Rule editor summary

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`

Changes:

- summary labels now distinguish `Title template` and `Body template`
- summary cards now also show:
  - `Rendered title`
  - `Rendered body`
- applies to both:
  - `send_dingtalk_group_message`
  - `send_dingtalk_person_message`

### Inline automation manager summary

Updated:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Changes:

- inline create/edit summaries now match the full rule editor
- rendered example output is visible for both group and person DingTalk message actions

### Test coverage

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

New assertions verify that rendered example text appears alongside the raw template.

## Notes

- This slice intentionally keeps the summary read-only.
- The rendered preview uses static sample values so authoring remains deterministic.
- No existing recipient selection behavior changed.
