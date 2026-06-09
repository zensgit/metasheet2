# DF Large-BOM C3 Route Verification - 2026-06-08

## Scope

Wired the already-landed large-BOM C3 worker/planner helpers into read-only table-action routes:

- `POST /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/run`
- `POST /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/plan`

The existing start/get/cancel job routes remain unchanged.

## Boundary

The run route:

- requires integration read permission;
- rejects all browser-supplied body fields;
- loads the source from the server-side job `actionSnapshot`;
- runs the expansion through the configured source adapter as the request user;
- does not read or write target rows.

The plan route:

- requires integration read permission;
- accepts only a run-only `conflictPolicyReview`;
- rejects browser-supplied source/target/plan fields;
- reads existing target rows from the server-configured target sheet;
- merges run-only and table-scope duplicate policies into the C3 plan handoff;
- stores only the private plan artifact and returns values-free public evidence.

Not included:

- no C4 apply route;
- no target writes;
- no UI;
- no K3 write, Submit, Audit, BOM, production rollout, or batch apply enablement.

## Verification

Local verification:

```text
pnpm --filter plugin-integration-core test:http-routes
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
```

Route test locks:

- memory-only storage still fails before source/target access;
- start queues without source/target reads;
- run rejects browser-supplied source and reads through the source adapter only at run time;
- run uses the request principal;
- plan rejects browser-supplied target and reads only the configured target sheet;
- plan response is values-free and exposes `planRevisionPresent`.

## Next Gate

The next large-BOM slice is C4 route/wiring on top of the checkpoint apply writer. That slice must be separately reviewed because it introduces server-side writes through the target-scoped records API.
