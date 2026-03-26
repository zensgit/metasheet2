# Multitable Runtime Contract Alignment

Date: 2026-03-25
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`
Branch: `codex/multitable-next`

## Problem

The new clean multitable worktree had already moved the frontend and smoke/client contract to `/api/multitable/*`, but the backend runtime in `packages/core-backend/src/index.ts` still only mounted `univerMetaRouter()` under `/api/univer-meta` in non-production mode.

That created a real contract gap:

- frontend/workbench expected `/api/multitable/bases`
- frontend/workbench expected `/api/multitable/context`
- form/grid flows expected `/api/multitable/form-context`, `/views/:viewId/submit`, `/records-summary`
- attachment URLs and upload/delete flows expected `/api/multitable/attachments/*`

The old multitable worktree already contained a fuller backend contract for these routes, including base-aware context resolution and attachment endpoints. Re-implementing those handlers from scratch in the new worktree would have been slower and riskier than selectively backporting the proven runtime slice.

## Decision

Align the new worktree runtime to the already-declared multitable contract instead of weakening the frontend/smoke side back down to `/api/univer-meta`.

Scope chosen for this round:

- mount `univerMetaRouter()` at `/api/multitable`
- keep `/api/univer-meta` as a dev-only alias
- backport the richer `univer-meta` router from the old multitable branch
- backport only the migrations and targeted integration tests required to validate:
  - bases/context
  - form/record flows
  - attachments

Explicitly deferred in this round:

- comments formalization slice
- OpenAPI dist regeneration
- broader pilot/live smoke reactivation

## Implementation

### 1. Runtime mount restored

`packages/core-backend/src/index.ts` now mounts:

- `/api/multitable` -> `univerMetaRouter()`
- `/api/univer-meta` -> same router, but only as a non-production compatibility alias

This restores the public runtime path that the web client and smoke core already use.

### 2. Backported multitable router slice

`packages/core-backend/src/routes/univer-meta.ts` was backported from the old multitable branch to restore the missing higher-level contract, including:

- `GET /bases`
- `POST /bases`
- `GET /context`
- `POST /person-fields/prepare`
- `GET /form-context`
- `POST /views/:viewId/submit`
- `GET /records-summary`
- `POST /attachments`
- `GET /attachments/:attachmentId`
- `DELETE /attachments/:attachmentId`

### 3. Required schema migrations backported

Backported:

- `packages/core-backend/src/db/migrations/zzzz20260318110000_add_multitable_bases_and_permissions.ts`
- `packages/core-backend/src/db/migrations/zzzz20260319103000_create_multitable_attachments.ts`

These provide the backend storage shape required by the restored runtime contract:

- `meta_bases`
- `meta_sheets.base_id`
- `multitable_attachments`

### 4. Attachment runtime fixed in the new worktree

While validating attachments, the upload route still returned:

- `UPLOAD_UNAVAILABLE`

Root cause:

- `packages/core-backend/package.json` in the new worktree did not actually include `multer`, so the optional upload loader correctly returned `null`.

Fix:

- add `multer@^2.1.1` to `@metasheet/core-backend`
- keep `packages/core-backend/src/types/multer.ts` simple and CommonJS-compatible

## Verification

### Commands run

Backend:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/core-backend add multer@^2.1.1
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-form.api.test.ts \
  tests/integration/multitable-attachments.api.test.ts \
  --reporter=dot
```

Frontend:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web build
```

Smoke script syntax:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
node --check scripts/verify-smoke-core.mjs
```

### Results

- backend `tsc --noEmit`: passed
- backend targeted integration: `3 files / 18 tests passed`
- frontend workbench regression: `2 files / 15 tests passed`
- `@metasheet/web build`: passed
- `verify-smoke-core.mjs` syntax check: passed

Known local limitation:

- full `pnpm verify:smoke:all` still depends on the local smoke database and was previously blocked by `connect ECONNREFUSED 127.0.0.1:5435`

## Old Worktree Status

Old worktree:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable`
- branch: `codex/multitable-fields-views-linkage-automation-20260312`

Current conclusion:

- the old worktree directory itself can be deleted if needed, because its branch tip is already preserved by git refs and pushed remote state
- but it is **not recommended to delete it yet**

Reason:

- the old branch still contains `48` commits that are not yet migrated into `codex/multitable-next`
- only a small part of that history has been intentionally backported so far

Operational guidance:

- safe to delete only if you are comfortable using the branch/ref as the recovery source later
- safer to keep it until the remaining high-value multitable commits are either migrated or explicitly dropped

## Next Step

Now that the runtime contract is real again, the next highest-value step is:

1. wire the restored `/api/multitable` backend into higher-level smoke execution, not just syntax checks
2. continue selective migration from the old multitable branch, prioritizing:
   - legacy frontend seam wiring
   - attachment UI/workbench path
   - people preset field flow
