# DingTalk Directory OpenId And Password Logout - Development And Verification

Date: 2026-05-05

## Scope

This slice covers two related DingTalk public-form findings:

- Explain why account 3 can be bound by DingTalk directory import but still has missing `provider_open_id`.
- Add a safe sign-out path to the forced password-change page, so users who hit first-login password change can switch accounts without being trapped on that page.

## Account 3 Diagnosis

Current code shows two different identity update paths:

- Directory import/review path builds the DingTalk identity key from `corpId + openId` when `openId` exists, otherwise it falls back to `unionId` or `openId`.
- OAuth login/bind path writes `provider_open_id` from the real DingTalk OAuth profile after a successful DingTalk authorization callback.

So account 3 is not caused by the public-form auth gate or password-change logic. It is a directory-import pre-bind case where the directory source did not provide a usable `openId`, and the user has not completed a successful OAuth login to backfill it. Deleting and re-importing only fixes it if the next DingTalk directory sync payload includes `openId`; otherwise the record will be re-created with the same gap.

Recommended follow-up:

- Keep the current strict matching logic; do not synthesize or guess `openId`.
- Add an admin-facing warning for DingTalk directory users whose local identity has `unionId` but missing `openId`.
- If we need to repair account 3, prefer a real DingTalk OAuth bind/login or a directory sync refresh that returns `openId`, then verify the identity row.

## Development

Changed files:

- `apps/web/src/views/ForcePasswordChangeView.vue`
- `apps/web/tests/ForcePasswordChangeView.spec.ts`

Implemented behavior:

- Added a secondary `退出登录 / Sign out` button on the forced password-change page.
- Clicking it calls `/api/auth/logout` with `suppressUnauthorizedRedirect`.
- Local auth state is cleared even if the logout request fails.
- User is redirected to `/login`.
- Submit and logout buttons are mutually disabled while either action is in progress.

## Verification

Commands run:

```bash
pnpm --filter @metasheet/web exec vitest run tests/ForcePasswordChangeView.spec.ts --watch=false
git diff --check
```

Results:

- `ForcePasswordChangeView.spec.ts`: 2 tests passed.
- `git diff --check`: passed.

Coverage added:

- Existing password-change happy path still passes.
- New logout path verifies `/api/auth/logout` call, local token cleanup, auth-state cleanup hook, and redirect to `/login`.

## Remaining Work

- Durable repair for account 3 still needs a real source of `openId`: successful OAuth login/bind or a directory sync payload that contains it.
- If the business wants directory import to self-diagnose this earlier, add an admin UI badge such as `DingTalk OpenId missing; OAuth bind required`.
