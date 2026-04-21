# DingTalk Public Form Access State Development

Date: 2026-04-21

## Scope

This change stabilizes DingTalk public-form access rendering across the quick automation manager, advanced rule editor, and automation card link generation.

## Changes

- Added `getDingTalkPublicFormLinkAccessState()` to return `hasSelection`, `level`, and `summary` from one stable timestamp.
- Updated quick group/person automation summaries to use computed access states instead of separately deriving CSS class, data attributes, and summary text.
- Updated automation card public-form links to use the shared access state for summary and access level.
- Updated advanced rule editor group/person access summaries to use one derived access state per rendered selector.
- Trimmed public-form view ids before rendering view names, so whitespace-only ids show as `No public form link`.
- Suppressed advanced editor access badges when a stale public-form id is whitespace-only.

## User Impact

The UI now renders DingTalk form-link permission state consistently. A public-form link cannot show one level in CSS and another in `data-access-level` during expiry boundary renders, and stale whitespace ids no longer produce a misleading empty access badge.

## Files

- `apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/dingtalk-public-form-link-warnings.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
