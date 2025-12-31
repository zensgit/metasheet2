# Integration Suite Verification (2025-12-31)

## Scope
- Run full integration suite with `SKIP_PLUGINS=true` and `SKIP_PLUGINS=false`.
- Record whether the suite exits cleanly.

## Commands

### 1) Plugins skipped
```bash
cd packages/core-backend
SKIP_PLUGINS=true pnpm exec vitest run --config vitest.integration.config.ts --reporter=dot
```

Result:
- Completed successfully (exit code 0).
- Summary: `Test Files 5 passed | 3 skipped`, `Tests 42 passed | 21 skipped`.
- Expected logs observed:
  - Formula error for `INVALIDFUNC` (test asserts error handling).
  - Audit log warnings about missing `event_type` column (non-fatal in tests).

### 2) Plugins enabled
```bash
cd packages/core-backend
SKIP_PLUGINS=false pnpm exec vitest run --config vitest.integration.config.ts --reporter=dot
```

Result:
- Completed with failures (exit code 1).
- Summary: `Test Files 2 failed | 6 passed`, `Tests 4 failed | 47 passed | 12 skipped`.
- Failures:
  - `tests/integration/kanban-plugin.test.ts`
    - Plugin Activation: `plugins.find is not a function`
    - Event Registration: `Event timeout`
    - Permission Check: `plugins.find is not a function`
  - `tests/integration/plugins-api.contract.test.ts`
    - Expected `/api/plugins` response to be an array (received non-array)

## Notes
- Targeted runs (single test files) exit cleanly.
- Full suite no longer hangs when `SKIP_PLUGINS=true`.
- With plugins enabled, `/api/plugins` response shape appears incompatible with contract tests (likely returning an object instead of an array).
