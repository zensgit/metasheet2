# DingTalk Directory Account List Admission Verification - 2026-04-22

## Branch

- `codex/dingtalk-directory-account-list-admission-20260422`
- Base branch: `codex/dingtalk-person-recipient-binding-warning-20260422`

## Verification Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --watch=false
```

Result: passed. `1` test file, `34` tests.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --watch=false
```

Result: passed. `2` test files, `30` tests.

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Vite emitted existing non-blocking warnings about `WorkflowDesigner.vue` being both dynamically and statically imported, plus large chunks after minification.

```bash
git diff --check
```

Result: passed.

## Covered Scenarios

- Pending review queue manual admission still works.
- No-email pending review admission still submits username/mobile without an empty email field.
- Account list now offers manual create-and-bind for unbound DingTalk accounts.
- Account-list no-email admission submits `name`, `username`, `mobile`, and `enableDingTalkGrant` without `email`.
- Success result displays temporary password and onboarding copy.

## Non-Blocking Observations

- The repository still has unrelated dirty `node_modules` files under plugins/tools. They are not part of this slice.
