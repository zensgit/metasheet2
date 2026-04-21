# DingTalk Message Link Runtime Guardrails Verification - 2026-04-21

- Date: 2026-04-21
- Branch: `codex/dingtalk-message-link-runtime-guardrails-20260421`
- Scope: backend verification for DingTalk group/person message link guardrails
- Status: verified locally

## Verification Goals

Confirm that `AutomationExecutor` validates DingTalk message links at runtime before sending either group or person messages.

Expected runtime behavior:

- public form links are only emitted for same-sheet form views with public sharing enabled
- public form links require a non-empty `publicToken`
- public form links are rejected after `expiresAt` or `expiresOn`
- internal processing links are only emitted for same-sheet views
- group-message delivery does not call DingTalk webhooks when link validation fails
- person-message delivery does not emit notifications when link validation fails
- valid group/person message behavior remains unchanged

## Static Review

Implementation diff was reviewed for:

- backend-only changes under `packages/core-backend/src/multitable/automation-executor.ts`
- focused backend tests under `packages/core-backend/tests`
- no frontend source changes
- no schema, migration, or OpenAPI changes
- no unrelated formatting churn

Commands:

```bash
git diff -- packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/tests docs/development/dingtalk-message-link-runtime-guardrails-*.md
git diff --check
```

Result:

- executor validates public and internal link configs before delivery
- group and person paths use equivalent validation logic
- `git diff --check` reports no whitespace errors

## Automated Tests

Focused backend tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
```

Result: passed, 1 file / 109 tests.

Backend build:

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

Wider workspace gates were not run in this slice:

```bash
pnpm test
pnpm lint
pnpm type-check
```

## Required Regression Cases

Valid group-message cases:

- same-sheet form view with `publicForm.enabled = true`, non-empty `publicToken`, and no expiry
- same-sheet form view with a future `expiresAt` or `expiresOn`
- same-sheet internal view
- public form link and internal link configured together

Invalid group-message cases:

- `publicFormViewId` not found
- public form view from another sheet
- public form view that is not type `form`
- form view with `publicForm.enabled !== true`
- form view with missing or blank `publicToken`
- form view with past `expiresAt`
- form view with past `expiresOn`
- `internalViewId` from another sheet
- validation failure leaves DingTalk webhook mock uncalled

Valid person-message cases:

- same-sheet form view with `publicForm.enabled = true`, non-empty `publicToken`, and no expiry
- same-sheet form view with a future `expiresAt` or `expiresOn`
- same-sheet internal view
- public form link and internal link configured together

Invalid person-message cases:

- `publicFormViewId` not found
- public form view from another sheet
- public form view that is not type `form`
- form view with `publicForm.enabled !== true`
- form view with missing or blank `publicToken`
- form view with past `expiresAt`
- form view with past `expiresOn`
- `internalViewId` from another sheet
- validation failure leaves person-message delivery mock uncalled

## Manual Verification Plan

Use a local database and a safe DingTalk mock transport if manual verification is needed.

1. Create sheet A with a normal grid view and a form view.
2. Enable public sharing on the sheet A form view and confirm it has a public token.
3. Create sheet B with a form view and a normal view.
4. Configure a DingTalk group-message rule on sheet A with the sheet A public form view; expected delivery includes a fill link.
5. Reconfigure the same group-message rule to use the sheet B form view; expected execution fails before webhook delivery.
6. Disable public sharing on the sheet A form view; expected execution fails before webhook delivery.
7. Restore sharing and set an expired public form expiry; expected execution fails before webhook delivery.
8. Configure the group-message rule with a same-sheet internal view; expected delivery includes a processing link.
9. Reconfigure the group-message rule with a sheet B internal view; expected execution fails before webhook delivery.
10. Repeat the same public form and internal-link scenarios for a DingTalk person-message rule; expected failures occur before person delivery.

## Result Template

- Focused backend tests: passed, 1 file / 109 tests
- Backend build: passed
- `git diff --check`: passed
- Workspace gates: not run
- Manual group-message verification: not run; covered by unit tests
- Manual person-message verification: not run; covered by unit tests
- Notes: first focused test attempt failed before install because the fresh worktree had no local `vitest`; rerun passed after `pnpm install --frozen-lockfile`

## Release Risk Notes

This change may expose pre-existing invalid automation configs. That is expected, but release notes should mention that DingTalk automations with stale public form links, disabled public sharing, expired public forms, missing public tokens, non-form public views, or cross-sheet internal links will now fail during execution instead of sending an invalid link.
