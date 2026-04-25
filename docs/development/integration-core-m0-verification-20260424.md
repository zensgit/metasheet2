# Integration Core M0 Verification - 2026-04-24

## Commands

### CJS/MJS Syntax Check

```bash
find plugins/plugin-integration-core -maxdepth 3 -type f -name '*.cjs' -print | sort | xargs -n1 node --check
node --check plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs
```

Result: passed.

### Plugin Unit/Smoke Tests

```bash
pnpm -F plugin-integration-core test
```

Result: passed.

Output summary:

```text
plugin-runtime-smoke: all assertions passed
host-loader-smoke: PluginLoader load + activate path passed
credential-store: 10 scenarios passed
db.cjs: all CRUD + boundary + injection tests passed
staging-installer: all 7 assertions passed
migration-sql: 057 integration migration structure passed
```

### Manifest Validation

The default package script is blocked in this sandbox because `tsx` tries to create an IPC pipe and receives `listen EPERM`:

```bash
pnpm validate:plugins
```

Equivalent Node loader command:

```bash
node --import tsx scripts/validate-plugin-manifests.ts
```

Result: passed.

Relevant line:

```text
plugin-integration-core: Valid
```

### Migration Placement Check

```bash
find packages/core-backend/migrations packages/core-backend/src/db/migrations -maxdepth 1 -type f \
  | sed 's#^.*/##' \
  | sort \
  | rg '(^057|integration_core|integration)'
```

Result:

```text
057_create_integration_core_tables.sql
zzzz20260202093000_create_attendance_integrations.ts
```

No duplicate `057_*` migration name was found.

## Verified Behaviors

- Plugin manifest parses and validates through the repository validator.
- Plugin activation registers the health route and communication namespace against a mocked runtime context.
- Plugin discovery/loading uses the real backend `PluginLoader` in a no-listen smoke, then activates the loaded module with a minimal host context.
- Plugin deactivation clears local state.
- Credential store encrypts/decrypts, rejects tampered payloads, rejects missing production keys, and supports deterministic dev fallback.
- DB helper rejects non-`integration_*` tables, invalid identifiers, quoted-identifier bypass attempts, unbounded update/delete, and value injection.
- DB helper keeps host return shape for array-return query results, including `selectOne`, `countRows`, and empty `insertMany`.
- Staging installer provisions all five descriptors idempotently and materializes `required` into `property.validation`.
- Migration `057_create_integration_core_tables.sql` has the expected seven `integration_*` tables, scoped columns, primary-key shapes, updated-at trigger bindings, workspace-null unique indexes, and no DDL/index/FK table references outside the integration namespace.

## Not Verified In This Slice

- The SQL migration was not applied against a live Postgres database.
- The plugin was not activated through a running `MetaSheetServer` process with an HTTP listener.
- Tenant/workspace consistency across referenced rows is not enforced at the database layer in M0; direct-scope root rows and integration-only references were verified, but M1 must add service or trigger enforcement before external writes.
- `pnpm validate:plugins` package script could not run directly in this sandbox because of `tsx` IPC restrictions; the equivalent `node --import tsx` command passed.

## Required Follow-Up Before M1 Production Work

- Add a real Postgres or PGlite migration execution smoke for `057_create_integration_core_tables.sql`.
- Add a full backend hot-load smoke that exercises `MetaSheetServer -> PluginLoader -> createPluginContext -> plugin.activate()` and hits `/api/integration/health` over HTTP.
- Add service or trigger enforcement for cross-row tenant/workspace consistency on pipeline references.
- Fix kernel route/communication teardown before adding long-lived integration pipeline routes.
