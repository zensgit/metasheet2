# DingTalk Protected Form Allowlist Guardrail Development - 2026-04-21

- Date: 2026-04-21
- Branch: `codex/dingtalk-protected-form-allowlist-guardrail-20260421`
- Scope: frontend authoring guardrails for DingTalk group-message public form selectors
- Status: implemented and verified locally

## Background

DingTalk automation rules can include a public form link in group-message content. Existing frontend guardrails already warn when the selected form cannot produce a usable fill link, and a later access guardrail warns when a group-message form is fully public.

Protected DingTalk access modes introduce another user-facing risk. A form with `publicForm.accessMode` set to `dingtalk` or `dingtalk_granted` is not fully public, but it is also not necessarily restricted to selected users. If both `allowedUserIds` and `allowedMemberGroupIds` are empty, the form still allows every local user who satisfies the selected DingTalk protection mode:

- `dingtalk`: bound DingTalk local users
- `dingtalk_granted`: authorized DingTalk local users

That behavior is valid at runtime, but it can be surprising when the automation owner expects the group-message form to be filled only by specified users or member groups.

## Goals

- Keep the existing public-form risk warning for DingTalk group-message selectors when the selected form is fully public.
- Add an advisory warning for DingTalk-protected public forms when `accessMode` is `dingtalk` or `dingtalk_granted` and both allowlist arrays are empty.
- Limit the new allowlist guardrail to DingTalk group-message automation authoring.
- Do not enable the new allowlist warning for DingTalk person-message automation authoring.
- Do not block saving the automation rule.

## Non-Goals

- No backend behavior changes.
- No database migration or schema change.
- No change to public form token generation, form submission, or DingTalk delivery execution.
- No automatic allowlist population from the DingTalk group destination.
- No change to person-message recipient or public-form selector behavior beyond existing link-validity warnings.

## Design

### Warning Conditions

The new warning should be considered only after the selected form view is known to be a valid, usable public form link. Existing link-validity warnings should remain higher priority for cases such as:

- missing or stale selected view
- selected view is not a form/public-form view
- public sharing is disabled
- missing public token
- expired share configuration

After link validity passes, the group-message selector should evaluate access risk in this order:

1. Fully public form warning when `publicForm.accessMode` is missing or `public`.
2. Protected-empty-allowlist warning when `publicForm.accessMode` is `dingtalk` or `dingtalk_granted` and both allowlist arrays are empty.
3. No access warning when either `allowedUserIds` or `allowedMemberGroupIds` contains at least one ID.

Missing `allowedUserIds` or `allowedMemberGroupIds` values should be treated as empty arrays for warning purposes. Duplicate IDs do not matter for this guardrail because it only needs to know whether at least one allowlist entry exists.

### Implemented Warning Copy

The protected-empty-allowlist warning distinguishes the selected access mode:

- `dingtalk`: `Public form sharing for "{Form Name}" allows all bound DingTalk users to submit; add allowed users or member groups when only selected users should fill.`
- `dingtalk_granted`: `Public form sharing for "{Form Name}" allows all authorized DingTalk users to submit; add allowed users or member groups when only selected users should fill.`

The UI wording preserves these points:

- the form is DingTalk-protected, not fully public
- it is not restricted to selected users
- empty allowlists allow all users admitted by the selected DingTalk protection mode
- the owner should add allowed users or member groups for a selected-user workflow

### UI Placement

The warning should appear directly below the DingTalk group-message public form selector, matching the placement and visual treatment of existing public-form link warnings.

Expected surfaces:

- full automation rule editor group-message action
- inline automation manager group-message action

Not expected:

- DingTalk person-message public form selector
- non-DingTalk automation actions
- backend validation responses

### Shared Helper Behavior

The implementation extends the existing shared frontend public-form warning helper instead of duplicating selector-specific logic in Vue components.

Implementation details:

- `DingTalkPublicFormLinkWarningOptions.warnWhenProtectedWithoutAllowlist`
- `hasAllowlistIds()` checks whether either allowlist contains at least one non-empty string ID
- full automation rule editor enables both fully-public and protected-without-allowlist warnings for DingTalk group-message public form links
- inline automation manager enables the same group-message warnings
- DingTalk person-message public form selectors do not enable the protected-without-allowlist option

The helper should remain read-only:

- inspect selected view metadata
- inspect `publicForm` access fields
- return warning strings
- avoid mutating rule config or form-share config

### Rollout Impact

Expected impact is frontend-only and authoring-time only:

- no API contract change
- no backend runtime change
- no migration
- no schema update
- no save-blocking behavior
- no change to existing public form access enforcement

## Verification Summary

The detailed verification results live in `docs/development/dingtalk-protected-form-allowlist-guardrail-verification-20260421.md`.

Verification covered:

- fully public group-message forms still show the public-risk warning
- `dingtalk` and `dingtalk_granted` group-message forms with empty allowlists show the new warning
- either an allowed user or an allowed member group suppresses the new warning
- DingTalk person-message selectors do not opt into the new allowlist warning
- existing invalid-link warnings retain priority
- frontend tests and web build pass
