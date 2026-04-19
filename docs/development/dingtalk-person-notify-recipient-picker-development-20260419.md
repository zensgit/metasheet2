# DingTalk Person Notification Recipient Picker Development

- Date: 2026-04-19
- Branch: `codex/dingtalk-person-notify-20260419`
- Scope: authoring UX follow-up for direct DingTalk person automation messaging

## Goal

Remove the worst part of the MVP authoring flow: manually typing local `userId` values.

This slice keeps the backend config shape unchanged, but adds a searchable recipient picker on top of the existing `userIds` field in both automation editors.

## Approach

Reused the existing multitable comment mention candidate search instead of adding a new backend user-search endpoint.

Source:

- `client.listCommentMentionSuggestions({ spreadsheetId, q, limit })`

This keeps the change small:

- no new API routes
- no new persistence changes
- no change to the saved action config

## Frontend

Updated:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`

Changes:

- added a `Search and add users` input for `send_dingtalk_person_message`
- loads candidate users through the existing mention candidate API
- shows selectable suggestion rows with:
  - label
  - subtitle
  - stable `userId`
- shows selected recipients as removable chips
- keeps the existing `Local user IDs` textarea as the persistence source of truth
- still allows manual entry, but makes normal authoring path use search/add instead of raw ID memorization

## Compatibility

- backend config remains:
  - `userIds`
  - `titleTemplate`
  - `bodyTemplate`
  - optional link view IDs
- no migration changes
- no runtime behavior changes
- no API contract changes

## Tests

Updated:

- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

Covered:

- rule editor can search and add a DingTalk person recipient
- quick-create manager form can search and add a DingTalk person recipient before save
- saved payload still serializes to the same `userIds` array shape

## Deployment

- None
- No remote deployment
- No migration changes
