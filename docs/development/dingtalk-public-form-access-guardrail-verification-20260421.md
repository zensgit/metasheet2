# DingTalk Public Form Access Guardrail Verification - 2026-04-21

## Scope

This verification note is for the frontend authoring guardrail in DingTalk group-message automations. When a group-message action selects a public form view that is fully public, the editor warns:

> Public form sharing for "{Form Name}" is fully public; everyone who can open the DingTalk message link can submit. Use DingTalk-protected access and an allowlist when only selected users should fill.

The warning is advisory only. Saving the automation rule remains allowed.

## Expected Behavior

The warning should appear when all of these are true:

- the automation action is a DingTalk group-message action
- the action selects a form view for public-form linking
- the selected view has usable public-form sharing metadata
- the public-form access mode is public or effectively public by default

The warning should not appear when:

- the selected view is missing, stale, or not a form view
- sharing is disabled, expired, or missing a public token and the existing link warning is more accurate
- the selected public form uses Bound DingTalk users
- the selected public form uses Authorized DingTalk users
- the DingTalk action does not include a public-form view link

The warning is advisory only. Saving the automation rule should still be allowed.

## Static Review Checks

Review the final diff for these properties:

- source changes are limited to frontend authoring logic and tests
- no backend route, runtime, database, migration, or API contract changes are introduced for this slice
- the warning string matches the implemented product copy
- the helper or component logic treats missing `accessMode` as public only when the link is otherwise usable
- existing public-form link-validity warnings keep priority over this access-risk warning
- DingTalk person-message links do not opt into the fully-public group-message warning
- no unrelated DingTalk recipient, destination, or public-form runtime behavior is changed

Suggested static commands:

```bash
git diff -- apps/web docs/development/dingtalk-public-form-access-guardrail-*.md
git diff --check
```

## Focused Automated Tests

Planned frontend unit coverage:

- open public form returns the access-risk warning when group-message guardrails are enabled
- public form with missing `accessMode` returns the access-risk warning when group-message guardrails are enabled
- `dingtalk` access mode returns no access-risk warning
- disabled sharing, missing token, expired sharing, stale view ID, and non-form view cases continue to use existing link-validity warnings
- DingTalk group-message editor renders the warning below the selected public-form view control
- inline DingTalk group-message editor renders the same warning below the selected public-form view control

Suggested focused command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
```

## Build And Quality Gates

Run the frontend build after focused tests:

```bash
pnpm --filter @metasheet/web build
```

If dependency state is missing in the worktree, run install first:

```bash
pnpm install --frozen-lockfile
```

Record final results here after execution:

- focused frontend tests: passed, 3 files / 75 tests
- frontend build: passed
- `git diff --check`: passed

## Manual Verification Checklist

Use a local or staging tenant with DingTalk automation authoring enabled.

Scenario 1, open public form:

- create or identify a form view with sharing enabled
- set access mode to Anyone with the link or equivalent public mode
- remove all allowed users and member groups
- create a DingTalk group-message automation
- select the form view as the public form link
- expected: the warning appears with the exact product copy

Scenario 2, Bound DingTalk users:

- update the same form share to Bound DingTalk users
- reopen or refresh the automation editor
- expected: the access-risk warning is hidden

Scenario 3, Authorized DingTalk users:

- update the form share to Authorized DingTalk users
- reopen or refresh the automation editor
- expected: the access-risk warning is hidden

Scenario 4, invalid public-form link:

- disable sharing, remove the public token, or set an expired date
- select the form view in the DingTalk group-message editor
- expected: existing link-validity warning appears and the access-risk warning does not add conflicting copy

Scenario 5, non-form or stale selection:

- select a non-form view or simulate a stale view ID in the rule config
- expected: existing non-form or stale-view warning behavior remains unchanged

## Result Notes

- branch tested: `codex/dingtalk-public-form-access-guardrail-20260421`
- environment: local worktree after `pnpm install --frozen-lockfile`
- commands run:
  - `pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web build`
  - `git diff --check`
- automated test result: passed
- manual scenario result: not run in browser in this slice
- known residual risks: warning is advisory only; runtime access behavior remains governed by existing public-form access mode and allowlists
