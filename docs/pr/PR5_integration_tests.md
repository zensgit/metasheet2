# PR#5: Plugin Integration Tests & CI

Purpose
- Increase confidence with failure-path coverage and basic success-path checks for the plugin system.

Scope
- Core backend tests only (Vitest). No end-to-end browser tests in this PR.

Test Files
- `packages/core-backend/tests/plugin-loader.failures.test.ts:1`
  - INVALID_MANIFEST → records `PLUGIN_002`
  - PERMISSION_DENIED → records `PLUGIN_004`
  - ACTIVATION_FAILED → records `PLUGIN_005`
- `packages/core-backend/tests/plugin-loader.success.test.ts:1`
  - Valid manifest flows through load → activate without recording failures

How To Run
```bash
pnpm --filter @metasheet/core-backend test
```

CI Notes
- Recommended steps in workflow:
  - `pnpm lint` (non-blocking)
  - `pnpm --filter @metasheet/core-backend test`
  - `pnpm --filter @metasheet/web build`
- Coverage thresholds are deferred to a later PR for stability.

References
- Loader: `packages/core-backend/src/core/plugin-loader.ts:1`
- Errors: `packages/core-backend/src/core/plugin-errors.ts:1`
