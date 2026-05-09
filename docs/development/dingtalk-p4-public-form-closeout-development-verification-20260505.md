# DingTalk P4 Public Form Closeout Development And Verification - 2026-05-05

## Scope

This document closes the current DingTalk public-form slice on the 142 deployment:

- Recover DingTalk public-form access when a browser carries an expired local MetaSheet JWT.
- Return policy-level DingTalk OAuth errors instead of generic authentication failures.
- Confirm direct-user and platform-member-group allowlists for `dingtalk_granted` public forms.
- Record the current three-account test interpretation and remaining deployment risk.

No public form token, DingTalk webhook, DingTalk secret, or JWT value is recorded here.

## Development Summary

### Public Form Auth Recovery

Changed the backend public-form optional auth behavior:

- Public-form routes still optionally hydrate `req.user` when a valid bearer token is present.
- If the bearer token is expired or invalid and the request is a public-form request with `publicToken`, the middleware now continues without `req.user`.
- The public-form policy layer then returns the correct business response, such as `DINGTALK_AUTH_REQUIRED`, instead of the JWT middleware returning `Invalid token`.

Changed DingTalk strict-grant denials:

- Unlinked or not-enabled DingTalk users in strict grant mode now throw `DingTalkLoginPolicyError`.
- The auth callback returns a policy response instead of a generic `DingTalk authentication failed`.

Related source files:

- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/src/auth/dingtalk-oauth.ts`
- `packages/core-backend/tests/unit/jwt-middleware.test.ts`
- `packages/core-backend/tests/unit/dingtalk-oauth-login-gates.test.ts`

### Access Matrix Behavior

The intended matrix for DingTalk public forms is:

| Access mode | Anonymous | DingTalk-bound user | DingTalk grant required | Allowlist support |
| --- | --- | --- | --- | --- |
| `public` | Allowed | Allowed | No | Not allowed with allowlists |
| `dingtalk` | Denied until DingTalk login | Allowed if bound | No | Direct users and member groups |
| `dingtalk_granted` | Denied until DingTalk login | Allowed if bound and grant enabled | Yes | Direct users and member groups |

Important password behavior:

- Normal platform pages still enforce `must_change_password`.
- DingTalk-protected public-form access can proceed for a user with `must_change_password=true`; the form policy is based on DingTalk binding/grant/allowlist, not ordinary platform password-change gating.

### 142 Member Group Allowlist Setup

On 2026-05-05, the latest P4 protected form on 142 was configured with:

- Access mode: `dingtalk_granted`
- Direct allowed users: `1`
- Allowed member groups: `1`

Temporary group:

- Name: `P4 DingTalk Form Allowed Test`
- Member: account 2, `王松松 / wss142`

Backup:

- Previous form config backup on 142: `/tmp/metasheet-p4-member-group-allowlist-backup-20260505T003933Z.json`

Implementation note:

- The first probe after direct DB update still denied account 2 because the backend `metaViewConfigCache` had the old `allowed_groups=0` config.
- Restarting only `metasheet-backend` refreshed the cache and made the member-group allowlist effective.

## Three-Account Status

| Account | Current state | Expected result |
| --- | --- | --- |
| Account 1, `zhouhua@china-yaguang.com` | DingTalk-bound, grant enabled, direct allowlist user, no forced password change | Fully normal; can access the form |
| Account 2, `王松松 / wss142` | DingTalk-bound, grant enabled, `must_change_password=true`, member of temporary allowed group | Ordinary platform pages require password change; DingTalk public form can access through the allowed member group |
| Account 3, `P4 Unauthorized Target / p4unauth142` | DingTalk identity exists but is not in the current form allowlist; live client may still hit unlinked/mismatched DingTalk identity path | Must not access the form; expected denial is either not linked to an enabled local user or `DINGTALK_FORM_NOT_ALLOWED` depending on which DingTalk identity is used |

## Verification

### Automated Source Checks

Commands run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts tests/unit/auth-login-routes.test.ts --watch=false
git diff --check
```

Result:

- Backend targeted tests passed: 53 tests.
- `git diff --check` passed.

### Live 142 Auth Recovery Probe

Live probe used a real active public-form config and an intentionally invalid bearer token.

Result:

```text
active_public_form=1
http_status=401
result=dingtalk_auth_required
```

Interpretation:

- The request was no longer blocked by JWT middleware as `Invalid token`.
- It reached the DingTalk public-form policy and returned the expected `DINGTALK_AUTH_REQUIRED`.

### Live 142 Member Group Allowlist Probe

After adding account 2 to the temporary allowed group and restarting `metasheet-backend`, short-lived server-signed tokens were used only for policy probing. Token values were not printed or stored.

| Scenario | Result |
| --- | --- |
| Anonymous request | `401 DINGTALK_AUTH_REQUIRED` |
| Account 1 direct allowlist user | `200 OK` |
| Account 2 member-group user | `200 OK` |
| Account 3 not in allowlist | `403 DINGTALK_FORM_NOT_ALLOWED` |

### Current 142 Health

Current backend health after the latest restart:

```text
status=ok
success=true
plugins.total=13
plugins.active=13
dbPool.waiting=0
```

Current P4 form allowlist state:

```text
allowed_users=1
allowed_groups=1
temporary_group_members=1
```

## Remaining Items

- Manual client evidence: account 2 should open the current DingTalk form link and confirm the previous "not in authorized user group" message is gone.
- Manual client evidence: account 3 should still fail and must not gain access.
- Release hardening: 142 currently includes runtime/container hot patches. Replace them with a normal backend image build and deployment so the fixes survive the next rollout.
- Operational cleanup: decide whether `P4 DingTalk Form Allowed Test` should become a real production group or be removed after verification.

## Related Evidence Docs

- `docs/development/dingtalk-public-form-access-matrix-design-20260428.md`
- `docs/development/dingtalk-public-form-access-matrix-verification-20260428.md`
- `docs/development/dingtalk-public-form-auth-recovery-design-20260430.md`
- `docs/development/dingtalk-public-form-auth-recovery-verification-20260430.md`
- `docs/development/dingtalk-public-form-member-group-allowlist-verification-20260505.md`

