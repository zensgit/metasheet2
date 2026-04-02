# PLM Workbench Mainline Merge Release Readiness Design

## Background

`codex/plm-workbench-collab-20260312` had already reached local feature-complete PLM workbench parity, but PR `#563` was blocked by a dirty merge against `origin/main`.

The conflict set was not PLM-only. It mixed:

- PLM workbench frontend and backend files
- auth and app shell changes from mainline
- approval route and OpenAPI contract changes
- large attendance and multitable additions

That made "take ours everywhere" unsafe, and "take theirs everywhere" would have dropped the PLM collaborative work.

## Goals

- Preserve the PLM-workbench collaborative feature line
- Rebase the branch onto the current app shell, auth bootstrap, and route model from `main`
- Restore a passing release-candidate validation chain across:
  - web type-check + PLM tests
  - backend focused route tests + build
  - OpenAPI build + SDK build/tests

## Merge Strategy

### 1. Keep mainline platform shell where it is authoritative

Use `main` as the source of truth for:

- auth bootstrap and redirect flow
- router bootstrapping pattern
- feature-flag shell and access gating
- attendance and multitable additions

### 2. Keep PLM branch implementation where it is authoritative

Use the PLM branch as the source of truth for:

- `PlmProductView.vue`
- `PlmAuditView.vue`
- PLM collaborative helpers/composables
- PLM backend routes and helpers
- PLM OpenAPI/SDK contract additions
- PLM focused tests

### 3. Hand-merge shell bridge files

Three files required explicit synthesis instead of choosing one side:

- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/router/appRoutes.ts`

The result keeps mainline session/account/admin behavior while preserving PLM-focused navigation and route availability for:

- `/plm`
- `/plm/audit`
- `/workflows`
- `/approvals`

### 4. Regenerate generated artifacts instead of hand-editing them

For generated surfaces, the merge should be settled by source + rebuild, not by line-level conflict editing:

- `pnpm-lock.yaml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist-sdk/index.d.ts`

## Post-Merge Contract Fixes

The merge validation surfaced two additional release blockers that had to be repaired before the branch could be considered publishable:

### OpenAPI shared response parity

`attendance.yml` referenced `#/components/responses/Conflict`, but `base.yml` did not define it.  
The fix adds a canonical shared `Conflict` response to the OpenAPI base components.

### SDK-backed PLM client test parity

`plmWorkbenchClient.spec.ts` still assumed the pre-SDK fetch shape.  
After the runtime SDK client adoption, request options carry normalized headers that are best asserted through `Headers`, not plain object matching.  
The tests were updated to validate the real runtime contract.

## Release Position

After this merge, the branch is suitable for a release candidate push.  
Production release should still wait for:

1. remote CI checks to report and pass
2. staging smoke on PLM workbench critical flows
3. PR mergeability to become clean after the pushed merge commit
