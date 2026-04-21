# DingTalk Person Recipient Warning Utils Development - 2026-04-21

## Background

DingTalk person automation supports dynamic record recipient paths such as `record.assigneeUserIds`. The inline automation manager and standalone rule editor previously duplicated the same warning logic for these paths.

After centralizing member-group recipient warnings, the remaining duplicated user-recipient warning logic should also live in the shared DingTalk recipient warning utility.

## Changes

- Added `listDingTalkPersonRecipientFieldPathWarnings()` to `apps/web/src/multitable/utils/dingtalkRecipientFieldWarnings.ts`.
- Updated `MetaAutomationManager.vue` to use the shared helper.
- Updated `MetaAutomationRuleEditor.vue` to use the shared helper.
- Added utility-level tests for dynamic person recipient path warning behavior.
- Preserved existing user-facing warning text and behavior.

## Behavior

No user-facing behavior changes are intended in this slice.

- Valid user fields still produce no warning.
- Unknown fields still warn as not user fields.
- Known non-user fields still warn as not user fields.
- Member group fields still warn as not user fields when used in the user-recipient field path.

## Scope

This is a frontend refactor and test-hardening slice. It does not call DingTalk, change automation payloads, or change backend APIs.
