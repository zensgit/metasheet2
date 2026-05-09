# DingTalk Public Form Auth Recovery Verification - 2026-04-30

## Source Verification

Commands run from `/Users/chouhua/Downloads/Github/metasheet2`:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/jwt-middleware.test.ts tests/unit/dingtalk-oauth-login-gates.test.ts tests/unit/auth-login-routes.test.ts --watch=false
git diff --check
```

Result:

- `tests/unit/jwt-middleware.test.ts`: passed
- `tests/unit/dingtalk-oauth-login-gates.test.ts`: passed
- `tests/unit/auth-login-routes.test.ts`: passed
- total targeted tests: 53 passed
- `git diff --check`: passed

## Live 142 Verification

Backend log evidence before the fix:

- Multiple public-form requests showed `jwt expired`, matching the `Invalid token` report.
- DingTalk callback requests reached the backend and failed with `DingTalk account is not linked to an enabled local user`, matching the second account's sign-in failure.

142 hot-patch actions:

- Backed up container files under `/tmp/metasheet142-hotpatch-20260430-auth/` on 142.
- Patched the running `metasheet-backend` compiled auth files.
- Restarted only `metasheet-backend`.

Health check after restart:

```text
status=ok
success=true
plugins=13
plugins.active=13
dbPool.waiting=0
```

Public-form stale-token probe:

```text
active_public_form=1
http_status=401
result=dingtalk_auth_required
```

Interpretation:

- The request used a real active public-form token plus an intentionally invalid bearer token.
- The response was no longer the JWT middleware's `Invalid token`.
- The request reached the public-form DingTalk policy and returned `DINGTALK_AUTH_REQUIRED`, which is the expected re-auth path for a DingTalk-protected form.

## Remaining Manual Retest

- Previously bound account: reopen the DingTalk public-form link. Expected behavior is DingTalk re-auth or form access, not immediate `Invalid token`.
- Unlinked account: click DingTalk sign-in. Expected behavior is a 403 policy message indicating the account is not linked/enabled, unless the admin binds the user and enables the DingTalk grant first.
- Durable deploy: replace the 142 hot patch with the next normal backend image deployment.

