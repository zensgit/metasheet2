# DingTalk Public Form Password-Change Guard Design

- Date: 2026-04-28
- Scope: DingTalk protected public multitable form login flow

## Symptom

When opening a DingTalk protected public-form link, the page could render a misleading anonymous-form shell and then stop on `Password change required` before the form access checks completed.

## Root Cause

The public form endpoints intentionally use optional JWT auth:

- `GET /api/multitable/form-context?publicToken=...`
- `POST /api/multitable/views/:viewId/submit?publicToken=...`

Those endpoints must allow both anonymous public forms and DingTalk-protected forms. For DingTalk-protected forms, a bearer token carries the local user identity bound to a DingTalk account.

The bug was that optional auth reused the normal password-change guard. If a DingTalk-bound local user had `must_change_password = true`, `hydrateAuthenticatedUser()` returned `403 PASSWORD_CHANGE_REQUIRED` before public-form DingTalk access rules could run.

The public form route also did not opt out of shell bootstrap, so unrelated product-feature loading could run on a public route.

## Fix

Backend:

- Keep password-change enforcement unchanged for normal authenticated API routes.
- Allow password-change users to hydrate only when `isPublicFormAuthBypass(req)` is true.
- Preserve the existing exact route and public-token guards, so sibling multitable routes and missing-token requests are not broadened.

Frontend:

- Add `skipShellBootstrap: true` to the public form route metadata.
- Change the pre-context subtitle from anonymous-specific copy to neutral secure-loading copy.

## Expected Behavior

After this fix:

- Public-token form context and submit requests can evaluate DingTalk binding/grant state even if the bound local account has a temporary-password flag.
- Normal app routes still force `/force-password-change`.
- Public form routes without a `publicToken` still do not receive the bypass.
- Public form pages no longer display misleading anonymous copy while DingTalk-protected access is still loading.
