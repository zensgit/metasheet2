# DingTalk Protected Form Allowlist Guardrail Verification - 2026-04-21

- Date: 2026-04-21
- Branch: `codex/dingtalk-protected-form-allowlist-guardrail-20260421`
- Scope: frontend-only DingTalk group-message allowlist guardrail
- Status: verified locally

## Verification Goals

Confirm that DingTalk group-message automation authoring warns for protected public forms that are not limited to selected users, without changing backend behavior or person-message behavior.

The expected behavior is:

- group-message selectors still warn when a selected public form is fully public
- group-message selectors warn when `publicForm.accessMode` is `dingtalk` and both `allowedUserIds` and `allowedMemberGroupIds` are empty
- group-message selectors warn when `publicForm.accessMode` is `dingtalk_granted` and both allowlist arrays are empty
- group-message selectors do not show the protected-empty-allowlist warning when either allowlist has entries
- person-message selectors do not show the protected-empty-allowlist warning
- existing link-validity warnings remain higher priority than access-risk warnings

## Automated Verification

Commands run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/dingtalk-public-form-link-warnings.spec.ts tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
git diff --check
```

Result:

- focused frontend tests passed: 3 files, 80 tests
- web build passed
- `git diff --check` passed

Covered test cases:

- helper returns the existing fully public warning for a group-message selector when `accessMode` is missing or `public`
- helper returns the new warning for `accessMode = dingtalk` with empty or missing allowlist arrays
- helper returns the new warning for `accessMode = dingtalk_granted` with empty or missing allowlist arrays
- helper returns no protected-empty-allowlist warning when `allowedUserIds` contains at least one ID
- helper returns no protected-empty-allowlist warning when `allowedMemberGroupIds` contains at least one ID
- helper keeps invalid-link warnings primary for disabled sharing, missing token, expired links, stale view IDs, and non-form views
- full automation rule editor renders the new warning for DingTalk group-message actions
- inline automation manager renders the new warning for DingTalk group-message actions
- DingTalk person-message actions keep existing link warnings but do not render the new allowlist warning

## Manual Verification Plan

Use a sheet with a form view that has public sharing enabled and a valid public token.

1. Configure the form as fully public and select it in a DingTalk group-message automation public form selector.
2. Confirm the existing fully public risk warning appears.
3. Change the form to `accessMode = dingtalk` with no allowed users and no allowed member groups.
4. Confirm the new warning states the form is not limited to selected users and that all admitted DingTalk local users can submit.
5. Add one allowed user.
6. Confirm the new warning disappears.
7. Remove the allowed user, add one allowed member group, and confirm the warning disappears.
8. Repeat the empty-allowlist check for `accessMode = dingtalk_granted`.
9. Configure an equivalent DingTalk person-message automation and confirm the new allowlist warning does not appear.
10. Disable public sharing or remove the public token and confirm the existing link-validity warning is shown instead of the allowlist warning.
11. Save the automation rule and confirm the warning is advisory only and does not block saving.

## Regression Checks

- No backend files should be required for this slice.
- No schema or migration files should be changed.
- Existing public form access enforcement should remain unchanged.
- Existing DingTalk group/person delivery execution should remain unchanged.
- Existing public-form link warnings should keep their previous wording unless implementation intentionally updates shared copy.

## Results

- Focused frontend tests: passed, 3 files / 80 tests
- Web build: passed
- `git diff --check`: passed
- Manual group-message fully public warning: not run in browser in this slice; covered by component tests
- Manual group-message protected empty allowlist warning: not run in browser in this slice; covered by component tests
- Manual allowlist suppression: not run in browser in this slice; covered by component tests
- Manual person-message non-applicability: not run in browser in this slice; person-message selectors do not enable the new option
- Notes: first focused test attempt failed before install because fresh worktree had no local `vitest`; rerun passed after `pnpm install --frozen-lockfile`
