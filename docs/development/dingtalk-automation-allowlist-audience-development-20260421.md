# DingTalk Automation Allowlist Audience Development

- Date: 2026-04-21
- Branch: `codex/dingtalk-automation-allowlist-audience-20260421`
- Scope: automation editor and automation manager DingTalk public-form link summaries

## Goal

Make DingTalk automation authors see both:

- `Public form access`: the DingTalk protection mode for the selected public form.
- `Allowed audience`: the local allowlist scope that can submit after DingTalk checks.

This keeps the group-message flow clear when a form is broadcast to a DingTalk group but only selected local users or local member groups may fill it.

## Implementation

- Added public-form audience derivation to `DingTalkPublicFormLinkAccessState`.
- Added audience text for public, unavailable, DingTalk-bound, DingTalk-authorized, and allowlist-constrained public forms.
- Displayed `Allowed audience` in the inline automation manager message summaries for group and person DingTalk actions.
- Displayed `Allowed audience` on automation manager rule card public-form link chips.
- Displayed `Allowed audience` beside public-form selectors and in message previews in `MetaAutomationRuleEditor`.
- Updated the DingTalk admin operations guide to document that automation summaries use the same local allowlist counts as the form share manager.

## Behavior

- Fully public forms show `Anyone with the link can submit`.
- DingTalk-protected forms without local allowlists show that all bound or authorized DingTalk local users can submit.
- DingTalk-protected forms with local allowlists show local user/member-group counts, for example `1 local user can submit after DingTalk checks`.
- Missing, disabled, expired, non-form, or tokenless public-form selections show `Allowed audience unavailable`.

## Files

- `apps/web/src/multitable/utils/dingtalkPublicFormLinkWarnings.ts`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/dingtalk-public-form-link-warnings.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
