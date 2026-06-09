# Data Factory #2342 - C3 large-BOM planner handoff verification (2026-06-08)

## Scope

This stacked slice adds the read-only C3 planner handoff after a background
expansion job completes:

- load a completed authoritative expansion artifact;
- combine its private expanded rows with caller-provided existing target rows;
- reuse the existing C3 `planStockPreparationConflicts` planner;
- store a private plan artifact and revision on the job;
- expose values-free plan evidence through the public job projection.

It does not add a route, UI, target records API read, target write, PLM write,
K3 path, or C4 checkpointed apply.

## Contract

`planLargeBomBackgroundExpansionJob(...)` requires an authoritative artifact:

- `status='completed'`;
- `authoritative=true`;
- sealed artifact revision present.

Queued/running/failed/cancelled/expired jobs and completed jobs without a
sealed artifact fail closed through `LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE`.

The helper intentionally accepts `existingRows` as an explicit input. Future
route/worker wiring must load those rows from the server-scoped configured
target binding; browser-supplied target scope remains forbidden.

## Values-Free Evidence

The private job stores:

- full plan decisions;
- existing row count;
- plan revision;
- artifact revision linkage.

The public job projection exposes:

- `planRevisionPresent`;
- values-free planner evidence: counts, row counts, conflict types, duplicate
  diagnostics/resolution fingerprints and policy labels.

Public evidence must not expose project numbers, component ids/codes/names,
source ids, existing target values, target record ids, sheet ids, field ids,
raw rows, raw payloads, credentials, or tokens.

## Verification

Commands run:

```sh
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
```

Additional related suites to run before merge:

```sh
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:http-routes
```

Locked assertions:

- planner handoff refuses a non-authoritative job;
- completed artifact produces a persisted private plan artifact;
- public projection exposes `planRevisionPresent=true`;
- public plan evidence is values-free;
- no target read/write API is introduced in this slice.

## Deferred

Still gated:

- server-side target existing-row load for large-BOM planning;
- route/UI worker trigger;
- explicit checkpoint/frontier resume;
- C4 checkpointed apply.
