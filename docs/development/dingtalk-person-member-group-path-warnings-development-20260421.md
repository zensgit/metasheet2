# DingTalk Person Member Group Path Warnings Development - 2026-04-21

## Background

DingTalk person automations can target local users directly and can also resolve member groups from record field paths. The member-group picker only lists explicit member group fields, but manually typed paths were only warning for unknown fields and `user` fields.

That left known ordinary fields such as `record.fld_1` silent, even though they are not valid member group fields.

## Changes

- Updated `MetaAutomationManager.vue`.
- Updated `MetaAutomationRuleEditor.vue`.
- Reused `isDingTalkMemberGroupRecipientField()` for manual member-group recipient path validation.
- Added warnings when a known field is not a member group field.
- Preserved existing specialized warning for `user` fields: users should use the regular record recipient field path instead.
- Added coverage in both inline manager and standalone rule editor specs.

## Behavior

- Unknown fields still warn as unknown.
- `user` fields still warn to use Record recipient field paths.
- Known non-member-group fields now warn: `record.<fieldId> is not a member group field`.
- Valid member group fields remain accepted without warnings.
- This is a warning-only frontend guardrail; payload shape and save behavior are unchanged.

## Scope

No live DingTalk API or webhook is called by this change. The slice is limited to frontend validation feedback for configuring DingTalk person automations.
