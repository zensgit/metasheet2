# M0 Spike Findings — plugin-integration-core

> Status: ✅ Spike complete. Runtime path confirmed. 4 committed tests pass.
> Date: 2026-04-24
> PR #0 review: all 5 issues resolved in-file; 3 kernel-side gaps remain (see below).

---

## ⚠ Known kernel gaps — TODO before production

These are kernel-side limitations surfaced during spike. M0 works *around* them but they must be addressed (in the kernel, not in this plugin) before the M1 pipeline runner ships. Each bullet cites an exact file:line so a follow-up PR can target it.

### 1. `http.addRoute` has no functional `removeRoute`

`packages/core-backend/src/index.ts:284` implements `removeRoute(path)` as a no-op that only emits `logger.warn('Route removal not implemented')`. Consequence: when this plugin is deactivated or hot-reloaded the Express route registered at `plugins/plugin-integration-core/index.cjs:56` persists in the running process. In M1 that will mean stale `/api/integration/pipelines/*` endpoints bound to dead code after any reload.

**Scope of fix**: either implement real route removal on the Express `Router` (rebuild router on deactivate) or introduce a plugin-scoped sub-router that can be dropped atomically.

### 2. `communication.register` has no `unregister`

`packages/core-backend/src/index.ts:1320-1338` builds the `communication` helper with `register(name, api)` that does `pluginApis.set(name, api)`. There is no matching delete. If this plugin re-activates under a new module instance, the previous namespace remains and `communication.call('integration-core', ...)` may hit the stale closure.

**Scope of fix**: add `unregister(name)` to the `PluginCommunication` surface and call it from `deactivatePluginByName` (`src/index.ts:1410`).

### 3. `services.security.encrypt/decrypt` declared in types but not wired

`packages/core-backend/src/types/plugin.ts` declares `PluginServices.security` (and several other services) but the runtime factory at `src/index.ts:1351-1356` only injects `notification / automationRegistry / rbacProvisioning / platformAppInstances` and casts the result with `as unknown as PluginServices`. Any plugin written against the type declaration would silently get `undefined` at runtime.

**Workaround in this plugin**: `lib/credential-store.cjs` is self-contained (Node `crypto`, `INTEGRATION_ENCRYPTION_KEY` env) and does not rely on `services.security`.

**Scope of fix**: instantiate a security service backed by `packages/core-backend/src/security/encrypted-secrets.ts` and add it to the `services` object at `src/index.ts:1356`. Then credential-store can migrate.

---

## Runtime path (confirmed)

Active plugin loader path: `packages/core-backend/src/index.ts:1087` — `createPluginContext(loaded)`.

- Plugins discovered by `PluginLoader` (`packages/core-backend/src/core/plugin-loader.ts:221`), scanning `./plugins/` (override via `new MetaSheetServer({ pluginDirs: [...] })`).
- Manifests validated against a lenient Zod schema (`PluginManifestSchema`, `plugin-loader.ts:51`). Our `plugin.json` passes: v2 format, array permissions, string `main`.
- Activation goes through `activatePluginInstance()` → `plugin.activate(context)` (line 1392).
- `core/plugin-manager.ts` has its own `createPluginContext()` — an *enhanced* V2 context — but that path is NOT invoked for CJS plugins. We follow the `src/index.ts` path, same as `plugin-after-sales`.

## PluginContext shape at runtime (actual, not type-declared)

- `context.api` → full `CoreAPI` with `http.addRoute`, `multitable` (scoped via `createPluginScopedMultitableApi`), `database`, `events`, etc.
- `context.services` → at runtime only `notification / automationRegistry / rbacProvisioning / platformAppInstances`. The richer `PluginServices` type is a cast, not a binding.
- `context.communication` → `{ call, register, on, emit }`; in-process `pluginApis` Map. **No unregister (see gap #2)**.
- `context.storage` → in-memory `Map` per plugin — NOT persistent. Do not use for real state; use `context.api.database` instead.
- `context.logger` → plugin-scoped `Logger`.

## Scoping convention used in this plugin (aligns with existing tables)

All operational SQL tables in `057_create_integration_core_tables.sql` carry `tenant_id TEXT NOT NULL`, and where applicable `workspace_id TEXT` and `project_id TEXT`. This mirrors:

- `bpmn_process_definitions` (`packages/core-backend/migrations/049_*.sql`): `tenant_id TEXT` + `UNIQUE (key, version, tenant_id)`
- `plugin_configs` (`008_*.sql`): `tenant_id VARCHAR(255)` + composite unique with `(plugin_name, config_key, tenant_id)`
- `plugin-after-sales` ledger rows: `(tenant_id, app_id, project_id, …)`

K3 WISE 账套 / Yuantus PLM org_id 等外部系统维度不单独拆列，存在 `integration_external_systems.config` JSONB 中。

## DB access boundary (revised after review)

`lib/db.cjs` now exposes a structured CRUD builder only:

```
select, selectOne, insertOne, insertMany,
updateRow, deleteRows, countRows, transaction
```

The earlier regex-based SQL prefix scan has been removed — it was trivially bypassed by quoted identifiers like `FROM "users"`. The module has no `rawQuery` method. Table and column names pass through `IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/` and the table-prefix whitelist before any SQL is built; every value goes through parameterized placeholders.

If future features require raw SQL, add a validated method here — do not reintroduce an escape hatch.

## Plugin skeleton conventions (follow these for next plugins)

- `index.cjs` with `module.exports = { async activate(context) { ... }, async deactivate() { ... } }`
- `lib/*.cjs` for modular code (CommonJS throughout, no build step)
- `__tests__/*.test.cjs` — standalone Node `assert` tests; runnable via `node <path>` or through the `test` npm script
- Manifest v2.0 (`manifestVersion: "2.0.0"`)
- `main: "index.cjs"` (string form)
- `permissions: [...]` (array form) — normalized by `normalizePermissionList()` in plugin-loader
- Optional `app.manifest.json` for runtime bindings / platformDependencies

## Verification

```bash
cd /Users/chouhua/Downloads/Github/metasheet2
node plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs
node plugins/plugin-integration-core/__tests__/credential-store.test.cjs
node plugins/plugin-integration-core/__tests__/db.test.cjs
node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs
```

Or: `pnpm -F plugin-integration-core test`.

All 4 test files pass without a live database or the metasheet2 server — they exercise pure logic and mocked contexts. Two things remain untested at this layer and require downstream work:

- The SQL migration `057_create_integration_core_tables.sql` has not been applied against a real Postgres instance. M1 must include `pnpm migrate` CI.
- Full plugin activation through `PluginLoader` + `createPluginContext` requires booting the backend. The smoke test uses a mocked context that replicates the documented shape but does not exercise the real host.
