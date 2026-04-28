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

## Codex Recheck

Rechecked after PR review on 2026-04-28:

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

Results:

- `git diff --check`: passed after removing one trailing blank line from the design MD.
- Backend public-form integration test: passed, 19 tests.
- Frontend share-manager unit test: passed, 15 tests.
- Backend build: passed.
- Web build: passed, with the same existing dynamic/static import and large chunk warnings.

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

## 142 Deploy and Post-deploy Verification

PR #1212 was merged into `main` as commit `1084f6ebb81f79423d33f25fb4baed8f28e98208`.

GitHub Actions run:

- Run: `25042260683`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25042260683`
- Final status: `completed`
- Final conclusion: `success`
- Jobs: `build=success`, `deploy=success`

The first deploy attempt failed before the remote deploy stage finished because the deploy host root filesystem was full:

- Root filesystem before cleanup: `100%`, `0` available.
- Docker image usage before cleanup: `41.38GB` total, `37.88GB` reclaimable.
- Docker volumes were not pruned.

Cleanup performed on `142.171.239.56`:

- Removed one stale release image bundle under `artifacts/releases/dingtalk-image-bundles`.
- Removed 70 unused `ghcr.io/zensgit/metasheet2-backend` / `ghcr.io/zensgit/metasheet2-web` image IDs in two conservative batches.
- Root filesystem after cleanup and deploy: `55G` used, `20G` available, `74%`.

The failed workflow jobs were then re-run with `gh run rerun 25042260683 --failed`.

Remote container state after the successful deploy:

- `metasheet-backend`: `ghcr.io/zensgit/metasheet2-backend:1084f6ebb81f79423d33f25fb4baed8f28e98208`
- `metasheet-web`: `ghcr.io/zensgit/metasheet2-web:1084f6ebb81f79423d33f25fb4baed8f28e98208`
- `metasheet-postgres`: healthy
- `metasheet-redis`: healthy

Later non-doc mainline deployments can supersede the container image tag while still including `1084f6ebb81f79423d33f25fb4baed8f28e98208`.

Latest observed 142 state during this verification window:

- `metasheet-backend`: `ghcr.io/zensgit/metasheet2-backend:8cfcbab420ee2a8674379fc4d2a746b40ed87d53`
- `metasheet-web`: `ghcr.io/zensgit/metasheet2-web:8cfcbab420ee2a8674379fc4d2a746b40ed87d53`
- `metasheet-postgres`: healthy
- `metasheet-redis`: healthy
- Root filesystem: `56G` used, `19G` available, `76%`.

Docs-only merges that record this evidence do not trigger another Docker deploy because `.github/workflows/docker-build.yml` ignores `docs/**`.

Workflow deploy log markers:

- `=== DEPLOY START ===` / `=== DEPLOY END ===`: present.
- `=== MIGRATE START ===` / `=== MIGRATE END ===`: present.
- `=== SMOKE START ===` / `=== SMOKE END ===`: present.
- Smoke summary: `api/plugins=ok health=ok web=ok`.

Live HTTP checks:

```bash
curl -sS -m 10 http://142.171.239.56:8081/api/health
curl -sS -m 10 http://142.171.239.56:8081/
curl -sS -m 10 'http://142.171.239.56:8081/multitable/public-form/sheet_dingtalk_form_demo_20260420/view_form_dingtalk_demo_20260420?publicToken=pub_dingtalk_demo_20260420'
```

Results:

- `/api/health`: `200`, `status=ok`, `plugins.total=13`, `plugins.active=13`, `plugins.failed=0`.
- `/`: `200`, returned the MetaSheet frontend shell.
- Public-form route: `200`, returned the MetaSheet frontend shell and did not redirect to a password-change page at the HTTP shell level.

Runtime log check:

- Backend logs after deploy showed normal plugin registration and server startup.
- No real backend error stack, public-form exception, or DingTalk access-matrix error was observed in the checked deploy window.
- Web logs showed expected nginx startup and `200` responses for `/`, `/api/health`, and the public-form route.

Follow-up automated UI acceptance:

- `docs/development/dingtalk-public-form-access-matrix-ui-acceptance-verification-20260428.md` covers the share-panel access-rule card for `public`, `dingtalk`, and `dingtalk_granted`.
- The same follow-up verification covers selected allowed users, selected member groups, and candidate search rows displaying DingTalk binding / grant status.

Remaining manual check:

- Re-run a real DingTalk mobile flow for `public`, `dingtalk`, and `dingtalk_granted` if screenshots or product signoff evidence is required.
