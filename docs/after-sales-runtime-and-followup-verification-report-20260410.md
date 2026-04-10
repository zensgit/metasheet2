# After-sales Runtime And Follow-up Verification Report (2026-04-10)

## Scope
This verification report covers the four after-sales PRs delivered in the same batch:

- `#780` installer runtime adapters
- `#782` field policy route + UI gating
- `#777` follow-up edit flow
- `#778` follow-up due proof

## Commands Run
### `#780`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-automation-registry.test.ts tests/unit/after-sales-workflow-adapter.test.ts tests/unit/after-sales-installer.test.ts tests/unit/plugin-rbac-provisioning.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `DATABASE_URL=postgresql://metasheet:metasheet123@127.0.0.1:5432/metasheet_v2 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot`

### `#782`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/after-sales-field-policies.test.ts tests/unit/after-sales-plugin-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/AfterSalesView.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web build`
- `DATABASE_URL=postgresql://metasheet:metasheet123@127.0.0.1:5432/metasheet_v2 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot`

### `#777`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/after-sales-plugin-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/AfterSalesView.follow-ups.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web build`
- `DATABASE_URL=postgresql://metasheet:metasheet123@127.0.0.1:5432/metasheet_v2 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot`

### `#778`
- `pnpm install --frozen-lockfile` in the clean mainsync worktree (dependency bootstrap only; no repo-tracked file changes)
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/after-sales-plugin-routes.test.ts`
- `DATABASE_URL=postgresql://metasheet:metasheet123@127.0.0.1:5432/metasheet_v2 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot`
- `pnpm --filter @metasheet/core-backend build`

## Results
- ✅ `#780` local focused unit/build/install integration verification passed before merge.
- ✅ `#782` local route/unit/web/build/install verification passed before merge.
- ✅ `#777` local route/web/build/install verification passed after refresh onto latest `main`.
- ✅ `#778` local route/build/install verification passed after retargeting to `main` and refreshing onto latest `main`.
- ✅ `#780`, `#782`, `#777`, and `#778` are merged to `main`.

## PR Merge Record
- `#780` merged at `2026-04-10T14:52:23Z` as `e4a10ba4c441985b542c1ccde3780d4d3d7293c8`
- `#782` merged at `2026-04-10T14:59:34Z` as `40abae49d2cc311f5368413078ae1826a35e6d0c`
- `#777` merged at `2026-04-10T15:03:15Z` as `3ec53961c44d6eab1bc5ac0c2fdffce9198aac6f`
- `#778` merged at `2026-04-10T15:10:04Z` as `59e0d415407e356a01e0a2d4f776762079519200`

## Known Caveats
- The root repo worktree remains intentionally ignored for this batch because it is dirty and unrelated.
- One earlier `#778` PR comment had malformed inline code due to shell quoting; a clean replacement comment was posted with `--body-file`.
- A dirty older `after-sales-followup-due-proof` worktree existed locally and was not reused; final `#778` work used a new clean mainsync worktree to avoid pulling unknown local edits into the PR.

## Post-merge Smoke
- ✅ `pnpm --filter @metasheet/core-backend build`
- ✅ `pnpm --filter @metasheet/web build`
- ✅ `DATABASE_URL=postgresql://metasheet:metasheet123@127.0.0.1:5432/metasheet_v2 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot`
- ✅ `pnpm --filter @metasheet/web exec vitest run tests/AfterSalesView.spec.ts tests/AfterSalesView.follow-ups.spec.ts --watch=false`
