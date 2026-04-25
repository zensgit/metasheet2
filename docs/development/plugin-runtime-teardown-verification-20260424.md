# Plugin Runtime Teardown Verification - 2026-04-24

## Commands

### Target Runtime Teardown Test

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-runtime-teardown.test.ts --reporter=verbose
```

Result: passed (`3/3`).

Coverage:

- plugin-owned route returns the first activated handler while active;
- plugin-owned communication namespace is callable while active;
- deactivation calls plugin `deactivate()`;
- deactivation removes the owned communication namespace;
- deactivation disables the old route wrapper, returning 404 in the no-listen supertest app;
- reactivation of the same path serves the new handler, not the stale closure;
- failed activation removes partially registered route and communication resources;
- communication namespace collision fails the second plugin activation without deleting the original owner's namespace.

### Backend Type Check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed.

### Integration Core Plugin Regression

```bash
pnpm -F plugin-integration-core test
```

Result: passed.

Output summary:

```text
plugin-runtime-smoke: all assertions passed
host-loader-smoke: PluginLoader load + activate path passed
credential-store: 7 scenarios passed
db.cjs: all CRUD + boundary + injection tests passed
staging-installer: all 7 assertions passed
migration-sql: 057 integration migration structure passed
```

### Plugin Manifest Validation

```bash
node --import tsx scripts/validate-plugin-manifests.ts
```

Result: passed. `plugin-integration-core: Valid`.

### Plugins API Contract Regression

Default Vitest config excludes this integration file:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/plugins-api.contract.test.ts --reporter=dot
```

Result: blocked by config-level exclude, not by test failure.

Rerun with integration config:

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/plugins-api.contract.test.ts --reporter=dot
```

Result: passed.

Local note: this machine has no usable default Postgres database named `chouhua`, so the server logged degraded workflow/event/automation initialization errors during integration startup. The target contract still passed.

## Not Verified

- Full `plugin-integration-core` activation through a running `MetaSheetServer` plus `/api/integration/health` was not added in this slice.
- Physical Express stack removal was not implemented; stale wrappers are behaviorally disabled with `next()`.
