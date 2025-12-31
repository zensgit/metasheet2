# Plugin Loader + Integration Test Exit Verification (2025-12-31)

## Scope
- Plugin loader failure tracking + permission/version checks.
- Integration test exit behavior (targeted files).

## Changes Verified
- PluginLoader now tracks failed plugins (`getFailedPlugins`) and rejects invalid permissions / incompatible MetaSheet versions.
- Integration tests set `METASHEET_VERSION` from `packages/core-backend/package.json` to ensure consistent engine checks.
- Postgres pool config uses `allowExitOnIdle` in test env to avoid hanging processes.

## Commands Run

### 1) PluginLoader failure paths
```bash
cd packages/core-backend
SKIP_PLUGINS=false pnpm exec vitest run tests/integration/plugin-failures.test.ts \
  -t "PluginLoader failure paths" \
  --config vitest.integration.config.ts --reporter=dot
```

Result:
- Test Files: 1 passed
- Tests: 3 passed
- Expected loader errors logged for invalid permissions / version mismatch.

### 2) Comments API integration
```bash
cd packages/core-backend
SKIP_PLUGINS=true pnpm exec vitest run tests/integration/comments.api.test.ts \
  --config vitest.integration.config.ts --reporter=dot
```

Result:
- Test Files: 1 passed
- Tests: 1 passed
- Process exited normally.

## Notes
- Full integration suite not re-run in this pass.
- Prior runs showed vitest hanging after output; targeted runs now exit cleanly with `allowExitOnIdle` enabled.
