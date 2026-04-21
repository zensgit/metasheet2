# DingTalk Public Form Link Guardrails Development

- Date: 2026-04-21
- Scope: frontend authoring guardrails for DingTalk automation public-form links
- Branch: `codex/dingtalk-public-form-link-guardrails-20260421`
- Base: `codex/dingtalk-group-destination-field-warnings-20260421`

## Goal

Warn table owners before saving DingTalk group/person automation rules that reference a public form view which cannot currently produce a working fill link.

## What Changed

- Added a shared frontend helper for public-form link warnings.
- The helper checks selected form views for missing share config, disabled sharing, missing public token, expired sharing, stale view IDs, and non-form views.
- The full automation rule editor now shows the warning below DingTalk group/person public-form selectors.
- The inline automation manager now shows the same warning below DingTalk group/person public-form selectors.
- Updated DingTalk operator docs to remove stale "one rule cannot target multiple groups" language and document static/dynamic multi-group routing.

## Design Notes

- This is an authoring-time warning, not a save blocker.
- Backend DingTalk delivery still validates public-form availability before sending links.
- The helper is Vue-free so both editors share wording and public-form classification logic.
- Existing valid public-form fixtures were updated to include enabled share config and a token.

## Files Changed

- `apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/dingtalk-public-form-link-warnings.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Migrations

- None

## Deployment Impact

- Frontend authoring behavior only
- No backend runtime/API/schema changes
- No DB migration
