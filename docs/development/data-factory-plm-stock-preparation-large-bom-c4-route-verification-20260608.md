# DF Large-BOM C4 Route Verification - 2026-06-08

## Scope

Wired the checkpoint apply writer into large-BOM table-action routes:

- `POST /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs`
- `GET /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId`
- `POST /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId/run`

The route layer creates an apply job from the server-side C3 plan artifact, exposes values-free public status, and runs one checkpoint apply chunk through a target-scoped records API.

## Security Boundary

- Apply-job creation requires integration write/admin permission.
- Apply-job run requires integration write/admin permission.
- The browser may not send source, target, sheetId, plan, payload, or record data.
- The target sheet comes from the server-side action snapshot stored on the job.
- The run route builds a target-scoped records API from the private apply job target before invoking the writer.
- The route validates that an apply job belongs to the expansion job in the URL.

## Still Out Of Scope

- No UI.
- No automatic scheduler/loop.
- No production or batch rollout.
- No PLM/external DB write.
- No K3 write, Submit, Audit, or BOM write.

## Verification

Local verification:

```text
pnpm --filter plugin-integration-core test:http-routes
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:stock-preparation-apply-writer
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
```

Route test locks:

- read-only users cannot create or run checkpoint apply jobs;
- client-supplied target/sheet scope is rejected;
- apply-job creation performs no target write;
- apply-job run writes only through the configured target sheet;
- public responses are values-free.

## Next Gate

Before production/batch rollout, this path still needs an entity-machine large-BOM validation run with values-free evidence and an operator-visible rollback/retry procedure.
