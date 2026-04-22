# DingTalk Person Form Risk Parity Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-person-form-risk-parity-20260422`
- Scope: frontend DingTalk person-message public-form warnings

## Goal

Bring DingTalk person-message automation authoring to parity with group-message authoring for public-form access risk warnings.

Before this slice, both group and person messages showed blocking errors for unusable public-form links, and both showed access/audience summaries. Only group messages showed advisory risk warnings for:

- fully public form links
- DingTalk-protected form links without local allowlists

Person messages can also carry those links, so they should show the same warnings.

## Implementation

- Updated `MetaAutomationRuleEditor` person-message public-form warning call to enable DingTalk access-risk warnings.
- Updated `MetaAutomationManager` inline person-message form warning call to enable the same access-risk warnings.
- Renamed the local helper argument from group-specific wording to DingTalk access-risk wording.
- Added tests for person-message fully public warnings in:
  - advanced rule editor
  - inline automation manager form
- Added tests for person-message protected-without-allowlist warnings in:
  - advanced rule editor
  - inline automation manager form
- Updated DingTalk admin and capability docs so warning behavior is described for group and person messages.

## Files

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This is advisory UI behavior only.
- Save-blocking validation is unchanged and still only uses blocking public-form link errors.
- Runtime delivery behavior is unchanged.
