# DingTalk Automation Advanced Create Manager Development - 2026-04-21

## Background

The DingTalk automation stack already has:

- Advanced rule editor entry from the automation manager.
- Editor-level payload coverage for DingTalk group/person actions.
- API contract normalization for `{ data: { rule } }` create responses.

The missing coverage was the manager-level save-through path: a user clicks the primary `+ New Automation` entry, configures DingTalk in `MetaAutomationRuleEditor`, saves, and the manager calls `MultitableApiClient.createAutomationRule()` with the full V1 payload.

## Scope

- Add manager-level regression coverage for advanced DingTalk group automation creation.
- Add manager-level regression coverage for advanced DingTalk person automation creation.
- Make the test `POST /automations` mock return the backend-like `{ rule }` envelope so the manager path also exercises the client normalizer from the API contract PR.

## Implementation

- Updated `apps/web/tests/multitable-automation-manager.spec.ts`.
- Group test verifies:
  - Primary advanced entry opens the editor.
  - Static DingTalk groups and dynamic record destination fields are preserved.
  - Public form and internal processing view IDs are preserved.
  - Legacy `actionType/actionConfig` and V1 `actions[]` are both posted.
  - Created rule appears in the manager list using the normalized returned rule.
- Person test verifies:
  - Static user IDs and member group IDs are preserved.
  - Dynamic user and member-group record field paths are preserved.
  - Public form and internal processing view IDs are preserved.
  - Legacy `actionType/actionConfig` and V1 `actions[]` are both posted.
  - Created rule appears in the manager list using the normalized returned rule.

## Files Changed

- `apps/web/tests/multitable-automation-manager.spec.ts`

## Notes

- No production component code was required because the advanced create entry already exists in the stacked base branch.
- This PR is intentionally a focused frontend regression hardening slice after the API contract canonicalization work.
- Dependency install created tracked `node_modules` symlink changes in plugin/tool workspaces; those artifacts are intentionally excluded from the commit.
