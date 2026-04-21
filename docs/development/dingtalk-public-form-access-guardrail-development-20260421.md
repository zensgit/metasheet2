# DingTalk Public Form Access Guardrail Development - 2026-04-21

## Background

DingTalk group-message automations can include a public form link by selecting a form view. Existing authoring guardrails focus on whether the selected form can produce a usable fill link: share config exists, sharing is enabled, a public token exists, and the link is not expired.

This slice covers a different product risk. A DingTalk group message feels targeted because it is sent to a configured group, but a form view shared as fully public is not restricted to that group. Anyone who receives, forwards, or otherwise obtains the public link can submit the form.

This branch adds an authoring-time warning in the frontend automation editor when a DingTalk group-message action selects a public form view whose `publicForm` configuration is effectively open:

- the form share mode is public or missing an explicit protected DingTalk mode
- DingTalk protection is not enabled
- any existing allowlist would not apply while the mode is public

The implemented warning copy is:

> Public form sharing for "{Form Name}" is fully public; everyone who can open the DingTalk message link can submit. Use DingTalk-protected access and an allowlist when only selected users should fill.

The warning is advisory and does not block saving the automation rule.

## Design

### Scope

The guardrail should apply to DingTalk group-message automation authoring when the configured message includes or references a selected public form view.

In scope:

- frontend automation editor warning behavior
- DingTalk group-message action configuration
- selected form views with `publicForm` share metadata
- reuse of shared public-form warning logic where it avoids duplicated classification

Out of scope:

- backend access enforcement changes
- database schema or migration changes
- public form runtime behavior changes
- DingTalk person-message recipient warnings unless the implementation intentionally shares the same UI surface
- save blocking; this warning should not prevent saving the automation rule

### Open Public Form Detection

The UI should classify a selected form view as an open public form only when the access-risk warning is accurate. A conservative detection rule is:

- the selected view exists and is a form/public-form view
- `publicForm` is present and the share is currently enabled enough to produce a fill link
- `accessMode` is absent or equals `public`

If the selected form has missing share config, disabled sharing, missing token, expiry, stale view ID, or non-form view status, the existing public-form link warning should remain the primary warning. The access warning should avoid stacking misleading copy on top of a link that is not currently usable.

### Warning Placement

The warning should render close to the DingTalk group public-form view selector so the owner sees it while choosing the form. The expected placement is below the selector, consistent with existing DingTalk public-form link warnings.

Suggested behavior:

- show the access-risk warning when no higher-priority link-validity warning is present
- keep the existing link-validity warning copy and priority unchanged
- use the same visual warning style as other automation authoring guardrails
- hide the warning after switching to a protected public-form mode
- hide the warning after selecting a non-public-form content path or clearing the selected view

### Protected Modes

No warning appears when the selected public form is configured for an intended restricted mode, for example:

- `accessMode = dingtalk`
- `accessMode = dingtalk_granted`

If a protected mode has no allowlist, the form is still DingTalk-gated rather than fully public. More specific protected-mode guidance can be added later if needed.

### Expected Implementation Shape

The implementation extends the existing shared frontend helper:

- `listDingTalkPublicFormLinkWarnings` now accepts `{ warnWhenFullyPublic: true }`
- the full automation rule editor enables that option for DingTalk group-message public form links
- the inline automation manager enables that option for DingTalk group-message public form links
- DingTalk person-message public form links keep the previous default behavior

The helper does not mutate rule config. It only inspects the selected view and returns warning strings.

### Rollout Impact

Expected impact is frontend-only:

- no API contract change
- no migration
- no backend runtime behavior change
- no change to existing public form tokens or submissions
- no change to DingTalk delivery execution

The behavior change is visible only while authoring or editing automation rules.

## Verification Plan

Focused coverage added:

- helper returns the warning for a selected form view with public/effectively public access mode
- helper treats missing `accessMode` as public when the form share is otherwise usable
- helper returns no warning for `dingtalk` mode
- helper returns no warning when selected view is missing, stale, or not a form view
- editor renders the warning below the DingTalk group-message public-form selector
- existing link-validity warnings still render for missing token, disabled sharing, or expired links

Suggested commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

Manual validation checklist:

- create or use a form view with public sharing enabled, public mode, and no allowlist
- create a DingTalk group-message automation and select that form view
- confirm the warning text appears exactly as expected
- switch the form share setting to Bound DingTalk users and confirm the warning disappears
- switch the form share setting to Authorized DingTalk users and confirm the warning disappears
- disable public sharing or remove the token and confirm the existing link-validity warning remains the primary warning
