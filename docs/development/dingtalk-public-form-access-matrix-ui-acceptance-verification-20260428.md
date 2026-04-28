# DingTalk Public Form Access Matrix UI Acceptance Verification - 2026-04-28

## Scope

This document verifies the follow-up UI acceptance slice for the DingTalk public-form access matrix.

Changed files:

- `apps/web/src/multitable/components/MetaFormShareManager.vue`
- `apps/web/tests/multitable-form-share-manager.spec.ts`
- `docs/development/dingtalk-public-form-access-matrix-142-verification-20260428.md`
- `docs/development/dingtalk-public-form-access-matrix-ui-acceptance-design-20260428.md`
- `docs/development/dingtalk-public-form-access-matrix-ui-acceptance-verification-20260428.md`

## Commands

```bash
pnpm install
git diff --check
git diff -- apps/web/src/multitable/components/MetaFormShareManager.vue apps/web/tests/multitable-form-share-manager.spec.ts docs/development/dingtalk-public-form-access-matrix-142-verification-20260428.md docs/development/dingtalk-public-form-access-matrix-ui-acceptance-design-20260428.md docs/development/dingtalk-public-form-access-matrix-ui-acceptance-verification-20260428.md | rg -n "(access_token=|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]+|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET)" || true
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
pnpm --filter @metasheet/web build
```

## Results

- `pnpm install`: passed; lockfile was already up to date and packages were reused from the local store.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook/token/JWT-secret patterns.
- Focused frontend test: passed, 17 tests.
- Frontend build: passed.

Non-blocking build warnings:

- Existing dynamic/static import warning for `WorkflowDesigner.vue`.
- Existing large chunk warnings after minification.

## Cleanup

`pnpm install` rewrote several tracked workspace/plugin `node_modules` symlinks and `pnpm-lock.yaml` in the temporary worktree. Those install-only side effects were reverted before preparing this change.

## Coverage Added

- Access-rule card is asserted for all five operator-facing combinations:
  - `public` with no local allowlist.
  - `dingtalk` with no local allowlist.
  - `dingtalk` with a local allowlist.
  - `dingtalk_granted` with no local allowlist.
  - `dingtalk_granted` with a local allowlist.
- Candidate rows still display DingTalk user and member-group status.
- Selected allowlist user chips display DingTalk binding and grant status.
- Selected allowlist member-group chips now display `Members are checked individually`.

## Remaining Manual Evidence

A real DingTalk mobile signoff is still manual by design. It requires:

- A real DingTalk client session.
- A live DingTalk-bound local user.
- If testing `dingtalk_granted`, an enabled DingTalk form grant.
- Optional product evidence capture such as a screenshot or screen recording.

This slice removes the need to manually inspect the share-configuration access matrix for every code change, but it does not fake live DingTalk client evidence.

## Secret Handling

No webhook URL, DingTalk signing secret, bearer token, JWT, or raw `Authorization` header was added to source, tests, or docs.
