# Approval OpenAPI Contracts PR #1138 Rebase Development

Date: 2026-04-26

## Scope

PR #1138 (`codex/openapi-approval-contracts-20260424`) was behind `origin/main` and conflicted after the approval metrics/report contract landed on main.

This sync was completed in an isolated detached worktree:

`/Users/chouhua/Downloads/Github/metasheet2/.worktrees/pr1138-clean-review-20260426`

The original checked-out PR worktree was not modified.

## Conflict Resolution Strategy

The conflicted files were:

- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`

Resolution was source-first:

1. Resolve `packages/openapi/src/paths/approvals.yml` manually.
2. Regenerate `packages/openapi/dist/*` from source.
3. Regenerate `packages/openapi/dist-sdk/index.d.ts`.

## Contract Decisions

The PR's original goal remains intact: align approval OpenAPI contracts with the live backend routes.

Kept from PR #1138:

- direct response shapes for approval template create/get/patch/clone/publish/version routes, matching `packages/core-backend/src/routes/approvals.ts`;
- newly documented live approval inbox/read/remind routes:
  - `GET /api/approvals/pending-count`
  - `POST /api/approvals/{id}/mark-read`
  - `POST /api/approvals/mark-all-read`
  - `POST /api/approvals/{id}/remind`

Merged from main:

- `GET /api/approvals/metrics/report`, which intentionally keeps the mainline `{ ok, data }` metrics response shape because `packages/core-backend/src/routes/approval-metrics.ts` returns that wrapper.

## Validator Hardening

While rerunning OpenAPI validation after regenerating `dist`, the validator reported false positives:

- `x-plugin` OpenAPI extension keys were treated as HTTP methods;
- `/api/permissions/health` was reported as missing bearer auth, even though the backend JWT middleware explicitly whitelists that route.

`packages/openapi/tools/validate.ts` was updated to:

- skip path item keys that start with `x-`;
- whitelist `/api/permissions/health`.

Both changes are scoped to OpenAPI contract validation and do not affect runtime behavior.

## Generated Artifacts

Regenerated:

- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist-sdk/index.d.ts`

The normal `pnpm --dir packages/openapi/dist-sdk build` command could not run inside the detached worktree because package-local dependencies were not installed there. The same generation steps were executed with the already installed main worktree tool binaries to avoid mutating dependency links in the detached worktree.
