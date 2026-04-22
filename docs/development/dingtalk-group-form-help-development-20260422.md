# DingTalk Group Form Help Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-form-help-20260422`
- Scope: frontend DingTalk group destination guidance and automation authoring hints

## Goal

Make the DingTalk group binding flow clearer in the places where users configure it.

This slice addresses a practical ambiguity: binding a DingTalk group in MetaSheet means registering a group robot webhook as a send destination for the current table. It does not sync DingTalk group members and does not grant or control public form access.

## Implementation

- Expanded the DingTalk Groups tab scope note to state that group destinations are table-scoped robot webhooks.
- Clarified that registering a destination does not import DingTalk group members or control form access.
- Added inline help under the DingTalk group webhook URL field:
  - webhook comes from the target DingTalk group robot settings
  - saved destinations appear in this table's automation rule editor
  - access tokens are stored for delivery but masked in the UI
- Added inline help under the optional secret field:
  - `SEC...` is only needed for DingTalk robots using signature security
  - the field should remain empty when no signature secret is configured
- Improved the empty state to explain that a group robot webhook should be added before configuring group-message automations.
- Added automation rule editor hints:
  - static group picker lists only DingTalk group destinations registered for the current table
  - dynamic record field paths must resolve to DingTalk group destination IDs, not local users, member groups, or DingTalk group names
- Updated user/admin-facing DingTalk docs with the same model.

## Files

- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This is a frontend and documentation clarity slice only.
- No backend API, schema, migration, or permission behavior changed.
- Existing table-scoped access control remains unchanged: only users with automation management permission can manage DingTalk group bindings.
