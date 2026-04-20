# DingTalk Person Dynamic Recipients Development

Date: 2026-04-20
Branch: `codex/dingtalk-person-dynamic-recipients-20260420`

## Goal

Extend `send_dingtalk_person_message` so a rule can resolve recipient local user IDs from record data, instead of requiring only static `userIds`.

## Scope

- Backend:
  - add optional `userIdFieldPath` to `SendDingTalkPersonMessageConfig`
  - resolve recipient user IDs from `context.recordData`
  - merge static and dynamic recipients with dedupe
  - return clearer failure when a configured record path resolves no users
- Frontend:
  - add `Record recipient field path (optional)` to both automation editors
  - allow saving person-message rules with either static user IDs or a dynamic field path
  - show dynamic recipient summary in authoring UI
  - map `userIdFieldPath` back into edit state

## Implementation Notes

- Supported dynamic field path format:
  - `record.assigneeUserIds`
- Supported record values:
  - one string
  - comma/newline separated string
  - string array
  - numeric ID
  - object entries such as `{ id }`, `{ userId }`, `{ localUserId }`, `{ value }`
- Runtime normalization removes duplicate local user IDs before DingTalk lookup.

## Files Changed

- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Outcome

Admins can now configure a DingTalk personal notification rule that targets:

- explicit local users
- record-derived local users
- or both together

This gives a lightweight “who should fill this record” mechanism without introducing a new row/column ACL model first.
