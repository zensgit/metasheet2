# Data Factory PLM Stock Preparation Large-BOM Durable Storage Verification

Date: 2026-06-10

## Scope

This slice closes the #2425 entity-machine stop rule where the C3/C4 route stack
was present but `context.storage.durable` was `false`.

Implemented boundary:

- Reuse the existing host `plugin_kv` table as the durable plugin KV store.
- Create `plugin_kv` when absent on fresh install paths, while reusing existing
  `plugin_kv` on upgraded deployments.
- Widen `plugin_kv.key` to `text` so fully-scoped Large-BOM keys fit.
- Inject DB-backed `context.storage` only for `plugin-integration-core`.
- Keep all other plugins on process-local memory storage.

Not included:

- No production or batch rollout.
- No PLM write, external database write, raw SQL escape hatch, or K3 action.
- No browser-controlled storage key/value path.
- No multi-process checkpoint lease/CAS. That remains a production/batch
  blocker; this slice only unblocks the durable-storage validation rerun.

## Verification

Commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plugin-durable-storage.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:http-routes
git diff --check
```

Results:

- plugin durable storage unit tests: 8/8 passed.
- core backend TypeScript build: passed.
- Large-BOM job contract tests: passed.
- stock-preparation table-action neighbor tests: passed.
- integration-core HTTP route tests: passed.
- diff whitespace check: passed.

## Locked Behaviors

- `plugin-integration-core` receives `storage.durable === true`.
- Non-integration plugins keep `storage.durable === false` memory storage.
- A job value written through one durable storage instance is readable through a
  second instance backed by the same DB seam.
- Storage is scoped by plugin name; same key in a different plugin cannot
  cross-read.
- Long scoped job keys greater than 255 characters persist through the storage
  seam, with the migration creating `plugin_kv` when absent and widening
  `plugin_kv.key` to `text`.
- Backing-store failures become `PLUGIN_DURABLE_STORAGE_UNAVAILABLE` with
  values-free details (`pluginName`, `operation`) instead of raw key/value/SQL.
- Large-BOM route tests now start a job through one durable storage instance,
  remount routes with a second instance backed by the same store, and run the job
  from the second mount. This locks the #2425 class of failure at the route seam,
  not only inside the storage helper.
- Large-BOM route tests also cover durable-store failure responses and assert the
  response omits project values, component values, backing SQL, and storage keys.

## #2425 Rerun Expectation

After package rebuild and deploy, the #2425 evidence should move from:

```text
durableStorage=false
start.httpStatus=501
errorCode=LARGE_BOM_JOB_STORE_UNAVAILABLE
```

to:

```text
durableStorage=true
start.status=queued
jobIdPresent=true
```

The validation still must remain values-free. Do not post raw job ids, project
numbers, component codes/names, target sheet or field ids, idempotency keys, PLM
rows, SQL, connection details, raw payload JSON, or stack traces.

This is only the start-gate transition for #2425. The full #2425 validation
still needs the subsequent run/plan/apply/idempotence evidence on the entity
machine. Production/batch remains closed until that rerun passes and the separate
rollout gate is satisfied.
