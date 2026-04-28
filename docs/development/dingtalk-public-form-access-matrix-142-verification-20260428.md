# DingTalk Public Form Access Matrix 142 Verification - 2026-04-28

## Local Branch

- Worktree: `/private/tmp/ms2-dingtalk-public-form-access-matrix-142-20260428`
- Branch: `codex/dingtalk-public-form-access-matrix-142-20260428`
- Base: latest `origin/main` at verification time

## Commands Run

```bash
pnpm install
git diff --check
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

## Results

- `pnpm install`: passed, lockfile reused; no new package download required.
- `git diff --check`: passed.
- Backend public-form integration test: passed, 19 tests.
- Frontend share-manager unit test: passed, 15 tests.
- Backend build: passed.
- Web build: passed.

Non-blocking web build warnings:

- Existing dynamic/static import chunk warning for `WorkflowDesigner.vue`.
- Existing large chunk warnings after minification.

Non-blocking frontend test warning:

- Vite dev WebSocket port was already in use during the focused Vitest run; test process exited successfully.

## 142 Read-only Check

Read-only SSH and HTTP checks were run against `142.171.239.56`.

Observed state:

- Remote repo head: `dba5c8e fix(dingtalk): allow public form auth through password-change guard`
- Backend image: `ghcr.io/zensgit/metasheet2-backend:dba5c8eac44fbd468310078ecb7952752299dc5a`
- Web image: `ghcr.io/zensgit/metasheet2-web:dba5c8eac44fbd468310078ecb7952752299dc5a`
- Health endpoint: `status=ok`, `plugins.total=13`, `plugins.active=13`, `plugins.failed=0`

Backend log tail contained only startup-period database recovery / not-yet-accepting-connections warnings. No public-form or DingTalk access-matrix errors were observed in the checked tail.

The previously supplied local admin JWT file no longer validates against `/api/auth/me` and returns `401 UNAUTHORIZED`; no token value was printed or written to tracked files.

## Secret Handling

No webhook URL, DingTalk signing secret, bearer token, JWT, or raw `Authorization` header was added to source or docs.

Recommended post-merge/post-deploy secret scan: run the existing DingTalk release secret scan over the changed source files and this document set.

## Post-deploy Checklist

After the branch is merged and the GHCR images are deployed to 142:

1. Confirm `/api/health` reports all plugins active.
2. Generate or refresh a short-lived admin app token if needed; validate `/api/auth/me`.
3. Open the form sharing panel and confirm the access-rule card appears for all three access modes.
4. Confirm selected allowed users display DingTalk binding / authorization status.
5. Confirm candidate search rows display DingTalk status.
6. Re-run one real DingTalk public-form flow for each mode:
   - `public`
   - `dingtalk`
   - `dingtalk_granted`
7. Re-test a platform-created DingTalk user with `must_change_password = true`; expected behavior is form fill allowed through DingTalk public-form auth, while normal app routes still require password change.
