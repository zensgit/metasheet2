# Multitable OpenAPI RC Contract Cleanup - Verification - 2026-04-30

## Environment

- Worktree: `/tmp/ms2-openapi-rc-contract-20260430`
- Branch: `codex/multitable-openapi-rc-contract-cleanup-20260430`
- Base commit: `origin/main@751cb8439` after clean rebase
- Node: `v24.14.1`
- pnpm: `10.33.0`

The worktree required `pnpm install --ignore-scripts` before OpenAPI generation because `/tmp` worktrees do not share the root checkout dependency resolution path. Plugin/tool node_modules symlink churn from that install was reverted before commit.

## Commands Run

```bash
pnpm install --ignore-scripts
pnpm exec tsx packages/openapi/tools/build.ts
pnpm exec tsx packages/openapi/tools/validate.ts
node --test scripts/ops/multitable-openapi-parity.test.mjs
pnpm run verify:multitable-openapi:parity
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts --reporter=dot
git diff --check
```

## Results

### OpenAPI Build

```text
Built OpenAPI to dist with parts: [
  'admin-plugins.yml',
  'approvals.yml',
  'attendance.yml',
  'audit.yml',
  'auth.yml',
  'comments.yml',
  'data-sources.yml',
  'multitable.yml',
  'permissions.yml',
  'plm-workbench.yml',
  'roles.yml',
  'spreadsheet-permissions.yml',
  'spreadsheets.yml',
  'views.yml',
  'workflow-designer.yml',
  'workflow.yml'
]
```

### OpenAPI Parity Guard

```text
OpenAPI security validation passed

> metasheet-v2@2.5.0 verify:multitable-openapi:parity /private/tmp/ms2-openapi-rc-contract-20260430
> pnpm exec tsx packages/openapi/tools/build.ts && node --test scripts/ops/multitable-openapi-parity.test.mjs

✔ multitable openapi stays aligned with runtime contracts (0.64175ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 42.279541
```

### Backend Runtime Contract

```text
> @metasheet/core-backend@2.5.0 build /private/tmp/ms2-openapi-rc-contract-20260430/packages/core-backend
> tsc
```

```text
✓ tests/integration/multitable-context.api.test.ts  (15 tests) 657ms

Test Files  1 passed (1)
     Tests  15 passed (15)
```

### Whitespace

```text
git diff --check
# clean
```

## Assertions Covered

- `MultitableFieldType` includes all 18 RC field types, including MF2 additions: `currency`, `percent`, `rating`, `url`, `email`, `phone`.
- `MultitableViewType` includes all 8 RC view types, including `gantt` and `hierarchy`.
- Field create/update request schemas reference `MultitableFieldType`.
- View create/update request schemas reference `MultitableViewType`.
- XLSX import/export paths exist in generated OpenAPI.
- XLSX export documents both `X-MetaSheet-XLSX-Truncated` and `Content-Disposition`.
- Backend create/update field routes accept MF2 field types.
- Backend field response serialization preserves batch1 field types instead of mapping them to `string`.

## Notes

- Phase 2 XLSX TODO entries were updated to point at merged PR `#1275` and merge commit `5c4130913`.
- Phase 3 TODO entries are marked complete for this PR, with merge fields left pending until the PR lands.
