# Integration Core M0 Verification - 2026-04-24

## Commands

### CJS Syntax Check

```bash
find plugins/plugin-integration-core -maxdepth 3 -type f -name '*.cjs' -print | sort | xargs -n1 node --check
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
credential-store: 7 scenarios passed
db.cjs: all CRUD + boundary + injection tests passed
staging-installer: all 7 assertions passed
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
- Plugin deactivation clears local state.
- Credential store encrypts/decrypts, rejects tampered payloads, rejects missing production keys, and supports deterministic dev fallback.
- DB helper rejects non-`integration_*` tables, invalid identifiers, quoted-identifier bypass attempts, unbounded update/delete, and value injection.
- DB helper keeps host return shape for array-return query results, including `selectOne`, `countRows`, and empty `insertMany`.
- Staging installer provisions all five descriptors idempotently and materializes `required` into `property.validation`.

## Not Verified In This Slice

- The SQL migration was not applied against a live Postgres database.
- The plugin was not activated through a running `MetaSheetServer` process.
- `pnpm validate:plugins` package script could not run directly in this sandbox because of `tsx` IPC restrictions; the equivalent `node --import tsx` command passed.

## Required Follow-Up Before M1 Production Work

- Add a real Postgres migration smoke for `057_create_integration_core_tables.sql`.
- Add a backend hot-load smoke that exercises `PluginLoader -> createPluginContext -> plugin.activate()`.
- Fix kernel route/communication teardown before adding long-lived integration pipeline routes.
