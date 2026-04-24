# Integration Core M0 Design - 2026-04-24

## Objective

Create the first reviewable system-plugin slice for the PLM/ERP integration pipeline. M0 is a runtime and security-boundary spike, not the full pipeline runner.

The goal is to prove that `plugin-integration-core` can be loaded as a CJS system plugin, register a minimal health route, expose an in-process communication namespace, define its credential/data access boundaries, and provision the staging multitable descriptors that later M1/M2 work will use.

## Scope

- `plugins/plugin-integration-core/plugin.json`
- `plugins/plugin-integration-core/package.json`
- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/lib/credential-store.cjs`
- `plugins/plugin-integration-core/lib/db.cjs`
- `plugins/plugin-integration-core/lib/staging-installer.cjs`
- `plugins/plugin-integration-core/__tests__/*.test.cjs`
- `plugins/plugin-integration-core/__tests__/*.test.mjs`
- `plugins/plugin-integration-core/SPIKE_NOTES.md`
- `packages/core-backend/migrations/057_create_integration_core_tables.sql`

## Runtime Design

The plugin follows the existing CJS plugin path used by `plugin-after-sales`:

- `PluginLoader` discovers `plugins/plugin-integration-core/plugin.json`.
- `main: "index.cjs"` exports `activate(context)` and `deactivate()`.
- `activate()` registers `GET /api/integration/health`.
- `activate()` registers `communication.register("integration-core", api)`.

The communication API is intentionally skeletal in M0:

- `ping()`
- `getStatus()`

M1 should attach the adapter registry, pipeline runner, dead-letter replay, and credential store operations behind this namespace.

## M0 Gate Hardening

Two lightweight gates were added after the initial M0 scaffold review.

### No-Listen Host Loader Smoke

`host-loader-smoke.test.mjs` imports the real backend `PluginLoader`, discovers `plugin-integration-core` through the manifest path, calls `load()`, and then activates the loaded plugin with a minimal runtime context. This covers the real manifest/main/module-loading path without opening an HTTP listener, which keeps it usable in restricted local sandboxes.

The smoke asserts:

- the plugin is discovered by id;
- the loaded CJS module exposes `activate`;
- `activate()` registers the integration health route;
- `activate()` registers the `integration-core` communication namespace;
- `ping()` and `getStatus()` are callable from the registered namespace.

### Migration SQL Structure Smoke

`migration-sql.test.cjs` statically checks migration `057_create_integration_core_tables.sql` until a live Postgres/PGlite execution gate is available.

The smoke asserts:

- the `integration_set_updated_at()` trigger helper exists;
- the migration is forward-only and does not drop tables;
- all seven expected `integration_*` tables are declared;
- primary-key shapes match the intended model, including `integration_watermarks.pipeline_id` as the 1:1 pipeline watermark key;
- scoped operational tables include `tenant_id` and `workspace_id`;
- tables with `updated_at` that are expected to mutate have an `integration_set_updated_at()` trigger;
- workspace-null uniqueness uses `COALESCE(workspace_id, '')`;
- DDL table references, index targets, and foreign key targets are limited to `integration_*` tables.

This is not a substitute for applying the migration against Postgres. It is an early guard against accidental scope drift and obvious DDL regressions.

## Security Boundaries

### Credentials

`lib/credential-store.cjs` uses AES-256-GCM envelope encryption.

- Production requires `INTEGRATION_ENCRYPTION_KEY`.
- Development/test may use a deterministic fallback key with a warning.
- Public callers receive fingerprints, not plaintext.

The plugin does not depend on `context.services.security` yet because the runtime path currently does not inject that service despite the type declaration. This gap is documented in `SPIKE_NOTES.md`.

### Database

`lib/db.cjs` deliberately exposes a structured CRUD builder only:

- `select`
- `selectOne`
- `insertOne`
- `insertMany`
- `updateRow`
- `deleteRows`
- `countRows`
- `transaction`

There is no `rawQuery` escape hatch. Tables must start with `integration_`, identifiers must pass a strict whitelist, and all values are parameterized.

This prevents the earlier regex-based SQL-scope bypass class such as quoted identifiers or injected `FROM "users"` clauses.

### Staging Multitable

`lib/staging-installer.cjs` provisions five user-visible staging surfaces:

- `plm_raw_items`
- `standard_materials`
- `bom_cleanse`
- `integration_exceptions`
- `integration_run_log`

The installer accepts local authoring sugar like `required: true`, but materializes it into the real multitable field contract under `property.validation`.

## SQL Model

Migration `057_create_integration_core_tables.sql` creates seven operational tables:

- `integration_external_systems`
- `integration_pipelines`
- `integration_field_mappings`
- `integration_runs`
- `integration_watermarks`
- `integration_dead_letters`
- `integration_schedules`

Root operational tables carry direct `tenant_id` scope; pipeline child tables such as mappings, watermarks, and schedules inherit tenant/workspace scope through `integration_pipelines`. Unique indexes use `COALESCE(workspace_id, '')` to avoid the Postgres `NULL != NULL` uniqueness trap on single-workspace deployments.

M0 does not enforce tenant/workspace consistency across referenced rows at the database layer. That remains a service-layer or trigger-level M1 gate because nullable `workspace_id` makes simple composite foreign keys insufficient in Postgres 14.

## Known Kernel Gaps

M0 documents, but does not fix, three plugin-kernel gaps:

- `http.addRoute` has no functional route removal.
- `communication.register` has no matching unregister.
- `services.security` is declared in types but not injected by the active CJS runtime path.

These are kernel follow-ups before the M1 pipeline runner is considered production-ready.

## Remaining M1 Gates

- Run migration `057_create_integration_core_tables.sql` against live Postgres or an in-repo PGlite-backed test once the dependency/environment is available.
- Add a full `MetaSheetServer` hot-load smoke that binds an ephemeral listener and exercises `/api/plugins` plus `/api/integration/health`.
- Enforce cross-row tenant/workspace consistency for pipeline references in service code or DB triggers before accepting external write paths.
- Keep route/communication teardown as a kernel follow-up before long-lived integration pipeline routes are introduced.

## Non-Goals

- No external K3 WISE adapter.
- No pipeline runner.
- No transform/validator/idempotency/watermark engine.
- No UI.
- No raw SQL plugin surface.
- No deletion or migration of the existing PLM adapter.
