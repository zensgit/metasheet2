# DingTalk Person Multi Recipient Fields Development

Date: 2026-04-20
Branch: `codex/dingtalk-person-multi-recipient-fields-20260420`

## Goal

Extend `send_dingtalk_person_message` from one dynamic record recipient field to multiple fields, so a rule can notify combinations like assignee + reviewer without duplicating rules.

## Scope

- Backend:
  - add optional `userIdFieldPaths` to `SendDingTalkPersonMessageConfig`
  - keep single `userIdFieldPath` backward compatible
  - normalize, merge, and dedupe recipients resolved from multiple record fields
  - expose `recipientFieldPaths` in success output
- Frontend:
  - allow comma/newline separated dynamic recipient paths in both automation editors
  - change field pickers from overwrite to append
  - show multi-field summaries using field labels where possible
  - map `userIdFieldPaths` back into edit state while still supporting legacy single-path rules

## Implementation Notes

- Runtime accepts both:
  - `userIdFieldPath`
  - `userIdFieldPaths`
- Authoring still stores readable `record.<fieldId>` paths, but picker interactions now append instead of replace.
- Runtime normalization strips the `record.` prefix, merges all configured fields, and removes duplicate local user IDs before DingTalk lookup.

## Files Changed

- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Outcome

Admins can now configure a single DingTalk personal notification rule that targets:

- static local users
- one dynamic record field
- or multiple dynamic record fields together

This reduces rule duplication for multi-step fill/approve flows while keeping the existing single-field configuration valid.
