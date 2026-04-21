# DingTalk Test Run Feedback Development

Date: 2026-04-21
Branch: `codex/dingtalk-test-run-feedback-20260421`
Base: `codex/dingtalk-automation-link-route-tests-20260421`

## Goal

Make automation Test Run behavior explicit for DingTalk rules.

Before this slice, `MetaAutomationRuleEditor` emitted a test event but did not explain that DingTalk actions can send real messages. `MetaAutomationManager` called the test API and ignored both success and failure results.

## Changes

- Added saved-rule gating in `MetaAutomationRuleEditor`.
  - Unsaved automations now show a “save before test” hint.
  - Test Run is disabled for unsaved rules and while a test is already running.
- Added DingTalk real-send warning in `MetaAutomationRuleEditor`.
  - The warning is based on draft `actions[]`, so it covers both group and person actions.
- Added per-rule Test Run feedback state in `MetaAutomationManager`.
  - Running, success, failed, and skipped outcomes are displayed.
  - Failed execution step errors are surfaced instead of being swallowed.
  - API errors are surfaced instead of silently failing.
- Refreshed per-rule automation stats after a completed test run.

## Review Fixes

- Normalized the frontend API error parser so backend responses shaped as
  `{ error: "message" }` surface the real message instead of falling back to
  `API <status>`.
- Kept compatibility with object-shaped errors such as
  `{ error: { code, message, fieldErrors } }`.
- Updated Test Run duration rendering to accept both backend-shaped
  `duration` and frontend-shaped `durationMs`.
- Scoped the running-state “DingTalk actions may send real messages” text to
  rules that actually include DingTalk group/person actions.

## Behavior Notes

- Test Run executes the saved server-side automation rule.
- Unsaved draft edits are not included until the rule is saved.
- DingTalk group/person test runs may send real DingTalk messages to configured destinations or recipients.
- This slice does not change backend execution semantics or DingTalk delivery logic.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
