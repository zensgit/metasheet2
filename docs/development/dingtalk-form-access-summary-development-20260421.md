# DingTalk Form Access Summary Development 2026-04-21

## Scope

This change adds a read-only public form access summary to DingTalk automation message previews.

## Changes

- Added `describeDingTalkPublicFormLinkAccess()` in `apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts`.
- The helper derives access state from `view.config.publicForm` without changing automation payloads.
- `MetaAutomationRuleEditor.vue` now shows `Public form access` for DingTalk group and DingTalk person message summaries.
- `MetaAutomationManager.vue` now shows the same summary in the inline create/edit form.
- Updated the DingTalk admin and capability guides to mention the new preview summary.
- Covered access states:
  - No public form link.
  - View unavailable or not a form.
  - Sharing not configured, disabled, missing token, or expired.
  - Fully public link.
  - All bound DingTalk users.
  - Bound DingTalk users constrained by allowlist.
  - All authorized DingTalk users.
  - Authorized DingTalk users constrained by allowlist.

## Design Notes

- The summary is intentionally read-only and does not persist into `actionConfig`.
- Existing group-message warnings remain responsible for blocking risky configurations visually.
- Person-message flows also display the access summary so owners can inspect the selected form link state even when group-specific warnings are not enabled.
- The summary depends on `props.views` carrying `config.publicForm`. If a caller omits this config, the UI will show the conservative sharing-state fallback instead of making an unsafe assumption.
