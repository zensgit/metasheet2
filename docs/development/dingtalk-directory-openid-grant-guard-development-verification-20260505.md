# DingTalk Directory OpenId Grant Guard - Development And Verification

Date: 2026-05-05

## Background

Account 3 exposed a gap in the DingTalk directory import/manual pre-bind flow:

- Directory sync can store a member with `unionId` but without `openId`.
- Manual bind/admission previously allowed enabling DingTalk login grant as long as either `unionId` or `openId` existed.
- Corp-scoped DingTalk OAuth login uses `corpId + openId` as the stable identity key, so a grant-enabled user without `openId` can look fully enabled in admin screens but still fail real DingTalk login.

This is a product/guardrail bug in the directory pre-bind flow. The fix keeps directory-only binding possible, but prevents silently enabling DingTalk login grant when `openId` is missing.

## Development

Changed files:

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/tests/unit/directory-sync-bind-account.test.ts`
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`

Backend behavior:

- Added a guard for corp-scoped DingTalk directory accounts: when `enableDingTalkGrant=true`, `openId` is required.
- Preserved union-only directory pre-binding when `enableDingTalkGrant=false`.
- Manual admission now fails before user creation if the request would enable DingTalk grant without `openId`.
- Route error mapping returns `400` for the new `missing DingTalk openId` policy error instead of falling through to `500`.

Frontend behavior:

- Directory account and pending-review bind panels now show a warning when `corpId` exists but `openId` is missing.
- The “绑定后同时开通钉钉登录” checkbox is disabled and unchecked for those accounts.
- Bind/manual-admission payloads automatically send `enableDingTalkGrant:false` when `openId` is missing, allowing directory binding without pretending DingTalk login is ready.

## Verification

Commands run:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync-bind-account.test.ts tests/unit/admin-directory-routes.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

Results:

- Backend: 2 test files passed, 35 tests passed.
- Frontend: 1 test file passed, 36 tests passed.
- `git diff --check`: passed.

Coverage added:

- Reject enabling DingTalk grant for corp-scoped directory accounts missing `openId`.
- Allow union-only directory pre-bind when DingTalk grant is disabled.
- Reject manual admission with DingTalk grant when `openId` is missing.
- Return route-level `400` for the new policy failure.
- UI warning and disabled grant toggle for missing-`openId` accounts.
- Bind payload sends `enableDingTalkGrant:false` when `openId` is missing.

## Remaining Operational Step

For the existing account 3, this code prevents future repeats but does not invent a missing `openId`. Repair still needs one of:

- A successful DingTalk OAuth bind/login to write the real `openId`.
- A corrected DingTalk directory sync payload that includes `openId`, then rebind/re-enable grant.
