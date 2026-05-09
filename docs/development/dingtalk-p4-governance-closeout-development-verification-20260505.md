# DingTalk P4 Governance Closeout Development And Verification - 2026-05-05

## Scope

This closeout consolidates the current DingTalk public-form and OpenID governance work into one mergeable package.

Included areas:

- DingTalk public-form optional-auth recovery.
- Public-form audience clarity for DingTalk and DingTalk-granted forms.
- Directory/user-management guardrails for missing `openId`.
- User-management governance workbench, screening, CSV/Markdown exports, and bulk grant closure.
- Admin audit deep links and scene presets for DingTalk governance actions.
- Forced password-change sign-out escape hatch for account switching.

Excluded areas:

- No secret, token, webhook, or live public-form token is recorded.
- No schema migration is introduced.
- No staging deployment is performed by this code slice.

## Design Summary

### Public Form Auth Recovery

Public-form routes intentionally use optional authentication. A stale or expired local bearer token must not block anonymous or DingTalk re-authenticated form access.

The JWT middleware now allows public-form requests with `publicToken` to continue when optional auth hydration fails. It also avoids applying local `must_change_password` blocking to DingTalk-protected public-form access, because that flow is governed by DingTalk identity, grant, and form allowlist policy.

### DingTalk Login Policy Errors

Strict DingTalk grant denials now return policy-shaped errors instead of generic auth failures. This gives public-form and OAuth callers a stable `403` policy failure for cases such as:

- grant required but absent
- DingTalk account not linked to an enabled local user

### Missing OpenID Guardrails

Corp-scoped DingTalk login depends on `corpId + openId`. A directory or user-management flow may still have `unionId`, but enabling DingTalk login grant without `openId` creates a misleading state: the UI appears enabled while real DingTalk login can fail.

The closeout applies the guard in three places:

- directory bind
- manual directory admission
- user-management single and bulk DingTalk grant enable

Directory-only binding remains allowed when DingTalk grant is not being enabled.

### Governance Workbench

User management now provides an operational surface for the missing-OpenID workflow:

- summary counts for missing, governed, and pending accounts
- `缺 OpenID` screening filter
- row-level risk and closure feedback
- CSV export for the current risk list
- bulk close for missing-OpenID users that still have DingTalk grant enabled
- Markdown exports for daily summary, validation checklist, result template, and execution package index
- direct links to directory repair and audit review

### Audit Scene Presets

Admin audit now supports DingTalk governance shortcuts:

- `resourceType=user-auth-grant`
- `action=revoke`
- optional recent 7-day range

The audit page hydrates filters from URL query params and keeps the URL synchronized after applying scene presets.

## Verification Plan

Run focused tests matching the touched surfaces:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/jwt-middleware.test.ts \
  tests/unit/dingtalk-oauth-login-gates.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/integration/public-form-flow.test.ts \
  --watch=false

pnpm --filter @metasheet/web exec vitest run \
  tests/ForcePasswordChangeView.spec.ts \
  tests/adminAuditView.spec.ts \
  tests/directoryManagementView.spec.ts \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-form-share-manager.spec.ts \
  tests/public-multitable-form.spec.ts \
  tests/userManagementView.spec.ts \
  --watch=false

pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

## Verification Results

### Backend Targeted Tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/jwt-middleware.test.ts \
  tests/unit/dingtalk-oauth-login-gates.test.ts \
  tests/unit/directory-sync-bind-account.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/integration/public-form-flow.test.ts \
  --watch=false
```

Result:

```text
Test Files  6 passed (6)
Tests       137 passed (137)
```

### Frontend Targeted Tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/ForcePasswordChangeView.spec.ts \
  tests/adminAuditView.spec.ts \
  tests/directoryManagementView.spec.ts \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-form-share-manager.spec.ts \
  tests/public-multitable-form.spec.ts \
  tests/userManagementView.spec.ts \
  --watch=false
```

Result:

```text
Test Files  7 passed (7)
Tests       97 passed (97)
```

Notes:

- The web Vitest run emitted the existing jsdom `Not implemented: navigation to another Document` stderr in navigation-oriented tests.
- The web Vitest run also emitted a WebSocket port-in-use warning before execution.
- Both were non-fatal; the command exited 0.

### Type Checks

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: both exit 0.

During verification, `vue-tsc` caught a DirectoryManagement helper type mismatch where a manual-admission result only had `accountId/integrationId`. The fix widened the local helper input type to optional `corpId/openId`, preserving runtime behavior while matching the actual call sites.

### Package Builds

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

Result: both exit 0.

Notes:

- After rebasing onto `origin/main`, the first backend build failed because the local dependency links had not yet picked up the mainline `xlsx` dependency used by `univer-meta.ts`. Running `pnpm install --frozen-lockfile` refreshed the workspace links, and the backend build then passed.
- The web build emitted existing Vite warnings about `WorkflowDesigner.vue` mixed static/dynamic imports and large chunks.
- No build failure was observed.

### Rebase Notes

The branch was rebased onto `origin/main` after formula-editor PRs landed.

Conflicts resolved:

- `apps/web/tests/multitable-form-share-manager.spec.ts`: kept mainline matrix/status coverage and this branch's DingTalk status assertions.
- `packages/core-backend/tests/integration/public-form-flow.test.ts`: kept the stricter `dingtalkPersonDeliveryAvailable` assertion.
- `packages/core-backend/tests/unit/jwt-middleware.test.ts`: kept context, submit, stale-token, and missing-public-token coverage.
- `docs/development/dingtalk-public-form-password-change-*`: normalized duplicate add/add docs into a single merged wording.

Two unrelated untracked `integration-core-stale-run-besteffort-*` docs blocked checkout because main already has files with the same names. They were copied to `/tmp/metasheet2-untracked-backup-20260505/` before being moved aside locally; they are not part of this PR.

### Patch Hygiene

```bash
git diff --check
```

Result: clean.
