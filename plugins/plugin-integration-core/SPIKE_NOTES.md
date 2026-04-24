# M0 Spike Findings — plugin-integration-core

> Status: ✅ Spike complete. Runtime path confirmed. Runtime teardown gaps #1/#2/#3 have host-side follow-ups.
> Date: 2026-04-24
> PR #0 review: all 5 issues resolved in-file; kernel-side runtime gaps are now tracked as fixed host capabilities.

---

## Kernel gap status

These are kernel-side limitations surfaced during spike. M0 works *around* them, but M1 pipeline work should treat this list as the runtime safety baseline.

### 1. `http.addRoute` has no functional `removeRoute` — fixed by host-owned teardown

The host now wraps plugin-owned routes with an owner registration. On plugin deactivation or activation failure, `MetaSheetServer` marks those wrappers inactive; stale wrappers call `next()`, so a later clean reactivation can serve the same path without hitting old closures.

Express stack entries are still not physically removed, but they are no longer behaviorally active after host cleanup.

### 2. `communication.register` has no `unregister` — fixed by host-owned teardown

The runtime now records communication namespaces by owning plugin. Deactivation and activation failure delete owned namespaces from the host `pluginApis` map. The plugin context also exposes optional `communication.unregister(name)` for explicit cleanup, but plugins do not need to rely on it for host safety.

### 3. `services.security.encrypt/decrypt` declared in types but not wired — fixed by host runtime adapter

`packages/core-backend/src/types/plugin.ts` declares `PluginServices.security` (and several other services). The active CJS runtime path now injects a host-backed `PluginRuntimeSecurityService` into `context.services.security` instead of leaving the typed property undefined.

The adapter intentionally reuses `packages/core-backend/src/security/encrypted-secrets.ts`, so plugin credentials can share the platform `enc:` AES-GCM secret format. It also exposes hash/verify/token/audit/rate-limit/threat-scan helpers. Sandbox code execution remains explicitly unavailable in this runtime path rather than pretending to provide full VM isolation.

**Current plugin state**: `lib/credential-store.cjs` remains self-contained (`v1:` format) for compatibility. M1 can migrate to `context.services.security.encrypt/decrypt` behind a backward-compatible reader that still accepts existing `v1:` payloads.

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
- `context.communication` → `{ call, register, unregister, on, emit }`; in-process `pluginApis` Map with host-owned cleanup on deactivate or activation failure.
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
node --import tsx plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs
node plugins/plugin-integration-core/__tests__/migration-sql.test.cjs
```

Or: `pnpm -F plugin-integration-core test`.

The plugin-level test files pass without a live database or the metasheet2 server — they exercise pure logic, mocked contexts, `PluginLoader` discovery/load, and static migration structure. Two things remain untested at this layer and require downstream work:

- The SQL migration `057_create_integration_core_tables.sql` has not been applied against a real Postgres instance. M1 must include `pnpm migrate` CI.
- Full plugin activation through `PluginLoader` + `createPluginContext` requires booting the backend. The smoke test uses a mocked context that replicates the documented shape but does not exercise the real host.
