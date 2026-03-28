# PLM Workbench Mainline Merge Release Readiness Verification

## Merge Resolution

Resolved the branch-vs-main conflict set in an isolated merge clone:

- merge target: `origin/main`
- branch: `codex/plm-workbench-collab-20260312`
- temp clone: `/tmp/metasheet2-plm-merge-20260328`

Authoritative shell files were hand-merged:

- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/router/appRoutes.ts`

Generated surfaces were rebuilt after conflict resolution:

- `pnpm-lock.yaml`
- OpenAPI dist outputs
- SDK type output

## Additional Fixes Landed During Verification

### OpenAPI conflict response

Added shared `components.responses.Conflict` to:

- `packages/openapi/src/base.yml`

### PLM SDK-backed client test parity

Updated request assertions to inspect normalized runtime headers via `Headers` in:

- `apps/web/tests/plmWorkbenchClient.spec.ts`

## Commands

### Dependencies

```bash
cd /tmp/metasheet2-plm-merge-20260328
pnpm install
```

### Frontend

```bash
cd /tmp/metasheet2-plm-merge-20260328
pnpm --filter @metasheet/web type-check

cd /tmp/metasheet2-plm-merge-20260328/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Results:

- `plmWorkbenchClient.spec.ts`: `23` tests passed
- PLM frontend suite: `62` files / `489` tests passed
- web type-check: passed

### Backend

```bash
cd /tmp/metasheet2-plm-merge-20260328/packages/core-backend
pnpm exec vitest run \
  tests/unit/plm-workbench-routes.test.ts \
  tests/unit/plm-workbench-team-views.test.ts \
  tests/unit/federation.contract.test.ts \
  tests/unit/approvals-routes.test.ts \
  tests/unit/approval-history-routing.test.ts

pnpm build
```

Results:

- backend focused suite: `5` files / `62` tests passed
- backend build: passed

### OpenAPI and SDK

```bash
cd /tmp/metasheet2-plm-merge-20260328
pnpm exec tsx packages/openapi/tools/build.ts

cd /tmp/metasheet2-plm-merge-20260328/packages/openapi/dist-sdk
pnpm build
pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```

Results:

- OpenAPI build: passed
- SDK build: passed
- SDK tests: `2` files / `12` tests passed

## Conclusion

The merge conflict blocker has been reduced to a verified merge commit candidate:

- no unresolved conflicts remain
- PLM frontend regression suite passes
- PLM/backend route suite passes
- OpenAPI and SDK generation pass again

At this point the branch is ready to be pushed as an RC candidate update to PR `#563`, after which remote CI and staging smoke remain the final release gates.
