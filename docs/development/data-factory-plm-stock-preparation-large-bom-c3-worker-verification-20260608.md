# Data Factory #2342 - C3 background expansion worker verification (2026-06-08)

## Scope

This stacked slice builds on the C3 job skeleton and adds the first background
expansion worker seam:

- run a queued/running/paused/failed background expansion job;
- read the PLM source through the configured source adapter;
- seal a private expansion artifact on success;
- mark scale/correctness failures as non-authoritative failed jobs;
- keep public job evidence values-free.

It is intentionally not the full checkpoint/frontier resume implementation.
It provides the execution and artifact seam that the later C3 checkpoint slice
can split into resumable chunks.

## Boundaries

Still out of scope:

- route/UI worker trigger;
- explicit frontier queue;
- chunk checkpoint resume;
- authoritative planner handoff;
- C4 checkpointed apply;
- MetaSheet target reads or writes;
- PLM/external writes;
- K3 writes.

The worker only calls `sourceAdapter.read(...)`. It never receives or uses a
records API and therefore cannot create or patch target rows.

## Worker Behavior

`runLargeBomBackgroundExpansionJob(...)`:

- requires durable job storage;
- requires a source adapter with `read()`;
- refuses cancelled/expired jobs;
- leaves completed jobs unchanged on retry;
- transitions runnable jobs to `running` before source reads;
- calls the existing app-side flat-read BOM expander;
- stores full private artifact rows only when the expansion is valid;
- seals an artifact revision derived from action snapshot, parameters,
  principal, expansion summary, and expanded rows;
- exposes only `artifactRevisionPresent`, not the artifact revision itself;
- sets `status='failed'` and `authoritative=false` on bounded or hard failures.

The C4 authoritative gate now requires all of:

- `status='completed'`;
- `authoritative=true`;
- a sealed artifact revision.

## Values-Free Evidence

Public job evidence may include:

- opaque job id;
- status;
- progress counters;
- source kind token;
- read object names;
- error type tokens;
- artifact-revision presence boolean.

Public job evidence must not include:

- project number;
- request principal;
- source binding id;
- target sheet id or field ids;
- component source ids;
- component code/name/material;
- path, parent, or idempotency keys;
- raw PLM rows;
- raw filters;
- raw SQL;
- credentials, tokens, or connection strings.

## Verification

Commands run:

```sh
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:http-routes
```

Locked assertions:

- completed background jobs become authoritative only with a sealed artifact
  revision;
- completed public projection is values-free and exposes only
  `artifactRevisionPresent`;
- the private artifact keeps the expanded rows for future planning;
- source reads are equality-filtered flat reads and carry no SQL/query fields;
- rerunning an already-completed job does not re-read the source and does not
  append duplicate artifact rows;
- scale budget failure stays non-authoritative and exposes values-free
  `max_rows_exceeded` evidence.

## Deferred

Still gated:

- C3 checkpoint/frontier resume with interruption tests;
- C3 authoritative planner handoff;
- C3 entity-machine validation;
- C4 checkpointed apply writer and route/UI handoff.
