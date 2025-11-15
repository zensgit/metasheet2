# TypeCheck Remaining Issues

This document tracks the remaining TypeScript type errors after initial @types packages were added.

## Fixed ✅
- Added `@types/express` - fixed ~20 express import errors
- Added `@types/jsonwebtoken` - fixed JWT middleware errors
- Added `@types/semver` - fixed plugin loader errors  
- Added `@types/cors` - fixed CORS configuration errors
- Added `@types/geoip-lite` - fixed audit service geoip errors
- Created `tsconfig.json` with appropriate compiler settings

## Remaining Issues (80+ errors)

### 1. Missing Metrics Properties
**Files affected**: `PluginContext.ts`, `enhanced-plugin-context.ts`, `PluginIsolationManager.ts`

Missing metrics on `metrics` object:
- `pluginExecutions`
- `pluginErrors`
- `pluginHttpRequests`
- `pluginDatabaseQueries`
- `pluginEvents`
- `pluginFileOperations`
- `pluginWorkersActive`
- `pluginExecutionTimeouts`
- `pluginWorkerCrashes`
- `pluginPermissionDenied`

**Fix needed**: Update `src/metrics/metrics.ts` interface to add these plugin-related counters/gauges.

### 2. Missing Database Table: `plugin_kv`
**Files affected**: `plugin-context.ts`, `enhanced-plugin-context.ts`

The code references a `plugin_kv` table that doesn't exist in the Kysely Database schema.

**Fix needed**: 
- Create migration for `plugin_kv` table
- Add `PluginKvTable` interface to database schema
- Update Database type in `src/db/schema.ts`

### 3. Missing PluginManifest Properties
**Files affected**: `plugin-context.ts`, `enhanced-plugin-context.ts`, `plugin-loader.ts`

Missing `path` property on `PluginManifest` type.

**Fix needed**: Update `PluginManifest` interface in `src/types/plugin.ts`.

### 4. Type Import Issues  
**Files affected**: `plugin-manager.ts`, `plugin-registry.ts`

Types imported with `import type` but used as runtime values:
- `PluginStatus`
- `PluginEvent`  
- `PluginCapability`

**Fix needed**: Change to regular imports `import { PluginStatus }` instead of `import type { PluginStatus }`.

### 5. Missing Service Methods
**Files affected**: `enhanced-plugin-context.ts`, `plugin-manager.ts`

Missing methods on service interfaces:
- `CacheService.on()`
- `NotificationService.on()`
- `WebSocketService.on()`
- `WebSocketService.getStats()`
- `SecurityService.on()`
- `SecurityService.getStats()`

**Fix needed**: Add event emitter methods to service interfaces or remove usage.

### 6. Glob API Changes
**Files affected**: `plugin-loader.ts`

`onlyDirectories` option doesn't exist on `GlobOptions` (glob v11).

**Fix needed**: Update to use glob v11 API with `{ withFileTypes: true }` and filter results.

### 7. Type Safety Issues
Various spread argument and union type issues in `enhanced-plugin-context.ts`.

**Fix needed**: Add proper type guards or assertions for REST parameter spreads.

## Incremental Fix Strategy

1. **Phase 1** ✅: Add missing @types packages (DONE)
2. **Phase 2**: Fix metrics interface (5-10 errors)
3. **Phase 3**: Add plugin_kv table schema (20-30 errors)
4. **Phase 4**: Fix type imports (20-25 errors)
5. **Phase 5**: Update service interfaces (5-10 errors)
6. **Phase 6**: Fix API compatibility issues (remaining errors)

## Running TypeCheck

```bash
cd packages/core-backend
pnpm exec tsc --noEmit
```

## Related

- PR #239: Initial typecheck CI workflow
- PR #259: Baseline abstraction (ViewService & RBAC stubs)
