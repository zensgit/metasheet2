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
- Completed successfully (exit code 0).
- Summary: `Test Files 8 passed (8)`, `Tests 51 passed | 12 skipped`.
- Expected logs observed:
  - Plugin failure fixtures log permission/version errors (expected for negative tests).
  - Formula error for `INVALIDFUNC` (test asserts error handling).
  - Audit log warnings about missing `event_type` column (non-fatal in tests).

Re-run command (for plugin focus, still runs full integration suite):
```bash
cd packages/core-backend
SKIP_PLUGINS=false LOG_LEVEL=info pnpm exec vitest run --config vitest.integration.config.ts --reporter=dot -- tests/integration/kanban-plugin.test.ts
```

## Notes
- Targeted run using `-- tests/integration/kanban-plugin.test.ts` still executes the full integration suite with current config.
- Full suite no longer hangs when `SKIP_PLUGINS=true`.
