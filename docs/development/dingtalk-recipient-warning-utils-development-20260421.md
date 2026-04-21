# DingTalk Recipient Warning Utils Development - 2026-04-21

## Background

DingTalk automation field-path warnings are shown in both the inline automation manager and the standalone rule editor. The group destination field warnings already live in `dingtalkRecipientFieldWarnings.ts`, but person member-group recipient warnings were duplicated in both Vue components.

After adding stricter warnings for manually typed member-group paths, keeping the same logic duplicated would make the two entry points easier to drift apart.

## Changes

- Added `listDingTalkPersonMemberGroupRecipientFieldPathWarnings()` to `apps/web/src/multitable/utils/dingtalkRecipientFieldWarnings.ts`.
- Updated `MetaAutomationManager.vue` to call the shared utility.
- Updated `MetaAutomationRuleEditor.vue` to call the shared utility.
- Added utility-level tests for person member-group recipient path warning behavior.
- Preserved the existing user-facing warning strings and behavior.

## Behavior

No user-facing behavior changes are intended in this slice.

- Unknown member-group recipient paths still warn as unknown fields.
- User fields still warn to use regular record recipient paths.
- Known non-member-group fields still warn that they are not member group fields.
- Valid member group fields still produce no warning.

## Scope

This is a frontend refactor and test-hardening slice. It does not call DingTalk, change automation payloads, or change backend APIs.
