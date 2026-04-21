# DingTalk Person Member Group Recipients Development

Date: 2026-04-20

## Goal

Extend `send_dingtalk_person_message` so sheet managers can target local member groups directly, instead of only:

- static `userIds`
- dynamic record user fields

The system should resolve selected member groups to active local users, then continue through the existing DingTalk binding and personal notification pipeline.

## Scope

- Add `memberGroupIds` to the automation action config
- Expand member groups to active local users at runtime
- Merge and deduplicate:
  - static `userIds`
  - member-group recipients
  - dynamic record user-field recipients
- Add manager-side authoring support in both automation editors
- Reuse existing sheet permission candidate search for user/member-group lookup
- Keep the change backward-compatible with existing person-message rules

## Backend Changes

Updated [automation-actions.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/packages/core-backend/src/multitable/automation-actions.ts:1):

- `SendDingTalkPersonMessageConfig` now accepts `memberGroupIds?: string[]`

Updated [automation-executor.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/packages/core-backend/src/multitable/automation-executor.ts:1):

- Validates requested member groups exist
- Resolves selected groups through `platform_member_group_members`
- Filters to active local users
- Merges resolved group users with static and dynamic recipients
- Returns explicit failures for:
  - missing groups
  - groups that resolve to no active users
  - rules with no effective recipients
- Reports member-group recipient counts in the action output

Updated [automation-v1.test.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/packages/core-backend/tests/unit/automation-v1.test.ts:1):

- Added focused coverage for member-group recipient expansion

## Frontend Changes

Updated [MetaAutomationManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/apps/web/src/multitable/components/MetaAutomationManager.vue:1) and [MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1):

- Search now uses `listFormShareCandidates(...)` so users and member groups can be suggested together
- Static person recipients and member-group recipients can both be added from search
- Added `Member group IDs (optional)` input
- Added selected member-group chips with remove actions
- Summary text now distinguishes:
  - `Users: ...`
  - `Groups: ...`
- Save validation now allows any of:
  - static users
  - static member groups
  - dynamic record recipient fields

Updated tests:

- [multitable-automation-manager.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/apps/web/tests/multitable-automation-manager.spec.ts:1)
- [multitable-automation-rule-editor.spec.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-person-member-group-recipients-20260420/apps/web/tests/multitable-automation-rule-editor.spec.ts:1)

## Migration / Deploy Impact

- No database migration
- No API shape break for existing rules
- Existing `userIds` and dynamic recipient-field rules continue to work unchanged
