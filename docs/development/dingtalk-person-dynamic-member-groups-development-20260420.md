# DingTalk Person Dynamic Member Groups Development

Date: 2026-04-20

## Goal

Extend `send_dingtalk_person_message` so sheet managers can resolve local member groups from record data at runtime, instead of only:

- static `userIds`
- static `memberGroupIds`
- dynamic record user fields

The model stays consistent with the existing DingTalk permission design:

- recipients are still our local users and member groups
- DingTalk remains a delivery channel and identity binding layer

## Scope

- Add dynamic member-group field paths to the automation action config
- Resolve member-group IDs from record data at runtime
- Merge and deduplicate:
  - static `userIds`
  - static `memberGroupIds`
  - dynamic record user-field recipients
  - dynamic record member-group-field recipients
- Keep existing person-message rules backward-compatible
- Add authoring support in both automation editors

## Backend Changes

Updated [automation-actions.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/packages/core-backend/src/multitable/automation-actions.ts:1):

- `SendDingTalkPersonMessageConfig` now accepts:
  - `memberGroupIdFieldPath?: string`
  - `memberGroupIdFieldPaths?: string[]`

Updated [automation-executor.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/packages/core-backend/src/multitable/automation-executor.ts:1):

- Added member-group ID extraction from record values
- Accepts string, array, and object-shaped record values for member-group IDs
- Merges static and dynamic member-group IDs before validating them
- Reuses the existing `platform_member_groups` and `platform_member_group_members` lookup path
- Returns explicit failures for:
  - missing member groups
  - dynamic member-group field paths that resolve to no recipients
- Extends action output with:
  - `dynamicMemberGroupRecipientCount`
  - `memberGroupRecipientFieldPath`
  - `memberGroupRecipientFieldPaths`

Updated [automation-v1.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/packages/core-backend/tests/unit/automation-v1.test.ts:1):

- Added success coverage for dynamic member-group record paths
- Added failure coverage for empty dynamic member-group record paths

## Frontend Changes

Updated [MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1) and [MetaAutomationManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/apps/web/src/multitable/components/MetaAutomationManager.vue:1):

- Added `Record member group field paths (optional)`
- Save validation now accepts rules that use only dynamic member-group field paths
- Summary cards now show:
  - `Record member groups: ...`
- Edit hydration now restores:
  - `memberGroupIdFieldPath`
  - `memberGroupIdFieldPaths`

Deliberate limit:

- No new picker was added for member-group record fields
- The existing picker still only lists `user` fields
- Dynamic member-group fields stay freeform `record.<fieldId>` paths for this slice

Updated tests:

- [multitable-automation-rule-editor.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/apps/web/tests/multitable-automation-rule-editor.spec.ts:1)
- [multitable-automation-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-dynamic-member-groups-20260420/apps/web/tests/multitable-automation-manager.spec.ts:1)

## Migration / Deploy Impact

- No database migration
- No API break for existing person-message rules
- Existing static-user, static-member-group, and dynamic-user-field rules continue to work unchanged
