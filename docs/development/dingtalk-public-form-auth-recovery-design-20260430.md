# DingTalk Public Form Auth Recovery Design - 2026-04-30

## Context

Two live DingTalk public-form symptoms were observed on the 142 deployment:

- A previously bound account opened a DingTalk public-form link and saw `Invalid token`.
- Another account clicked DingTalk sign-in and saw the generic `DingTalk authentication failed` message.

Backend logs showed two separate causes:

- The first flow carried an expired local MetaSheet JWT from browser storage. The public-form route uses optional auth, but the optional middleware still rejected stale bearer tokens before the form access policy could run.
- The second flow reached DingTalk OAuth callback, but strict DingTalk grant mode rejected the DingTalk account because it was not linked to an enabled local user. That strict-grant denial was thrown as a generic `Error`, so the route mapped it to a generic 500-style authentication failure.

## Design

### Public Form Optional Auth

Public-form access is already identified by `isPublicFormAuthBypass(req)` for:

- `GET /api/multitable/form-context?publicToken=...`
- `POST /api/multitable/views/:viewId/submit` with `publicToken`

For those routes, bearer auth is optional. A valid bearer token should still hydrate `req.user`, but an invalid or expired bearer token must not block the request. The request should continue unauthenticated so the public-form policy can decide the next step:

- anonymous public form: allow if the public token and form policy allow it
- DingTalk-protected public form: return `DINGTALK_AUTH_REQUIRED`
- allowlist-protected form: return the existing policy denial

### DingTalk Strict Grant Denials

Strict DingTalk grant mode is a policy decision, not a server failure. These cases now throw `DingTalkLoginPolicyError`:

- linked identity exists, but no enabled DingTalk grant is present
- email auto-link finds a local user, but no enabled DingTalk grant is present
- no linked/enabled local user exists while `DINGTALK_AUTH_REQUIRE_GRANT=1`

The auth route already maps `DingTalkLoginPolicyError` to its configured status and message, so the callback now returns a 403 policy response instead of a generic authentication failure.

## Operational Note

The 142 backend was hot-patched after source changes were made locally. The hot patch is suitable for immediate live retest, but it should still be replaced by a normal image build/deploy so the fix survives the next container rollout.

