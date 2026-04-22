# DingTalk Group Route And Empty State Development - 2026-04-22

## Goal

Continue the DingTalk standard feature work by tightening the table-bound DingTalk group route contract and improving the automation authoring experience when a table has no bound DingTalk groups.

## Implemented

- Added route-level integration coverage for `/api/multitable/dingtalk-groups`.
- Locked sheet-scoped permission behavior for list, update, delete, delivery history, and test-send routes.
- Locked create response redaction so webhook credentials are masked and the stored robot secret is not returned.
- Added an empty-state hint in both automation authoring entry points when the current table has no DingTalk group bindings.
- Preserved dynamic record group field paths as the valid fallback path when no static DingTalk group can be selected.

## Files

- `packages/core-backend/tests/integration/dingtalk-group-destination-routes.api.test.ts`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `docs/development/dingtalk-group-route-and-empty-state-development-20260422.md`
- `docs/development/dingtalk-group-route-and-empty-state-verification-20260422.md`

## Behavior Notes

- No backend runtime route or service behavior was changed in this slice; the backend work adds missing route contract tests.
- The frontend now tells the user to bind a DingTalk group in API Tokens & Webhooks > DingTalk Groups, or use a record group field path.
- Saving remains disabled when a DingTalk group action has no static destination and no valid dynamic destination field path.
- Saving remains enabled when a valid dynamic field path such as `record.fld_2` is configured with title and body templates.

## Out Of Scope

- No DingTalk person-message behavior was changed.
- No public form or granted-form runtime behavior was changed.
- No existing unrelated `node_modules` worktree changes were touched.
