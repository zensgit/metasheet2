# Data Source System Integration C6 - External Write Design

Status: C6-0 design + C6-1 latent target + C6-2 dry-run route + C6-3 token-bound apply route; C6-4 UI / C6-5 entity-machine validation still gated
Date: 2026-06-16

## Purpose

C6 is the final delivery gate for the database/system-connection track: external
write. C2-C5 prove the read path, incremental read path, operator configuration
surface, and K3/MSSQL read-only seam. They do not authorize writes.

C6 defines the write contract before any implementation:

- what external target may be written;
- who may dry-run and who may apply;
- how an operator proves that the apply writes the same revision they reviewed;
- how per-row failures are isolated;
- how dead-letter/provenance/evidence stay values-free;
- how sandbox-first validation proves idempotence and rollback posture before
  production is discussed.

## Grounding In Current Code

Current code has three relevant pieces:

1. `/data-sources` adapters are write-capable in the generic manager, but default
   read-only. `BaseDataAdapter.isReadOnly()` returns true unless
   `options.readOnly === false`, and `DataSourceManager.insert/update/delete`
   call `adapter.assertWritable()` before mutating.
   Current generic query routes also allow raw SQL execution against writable
   data sources. C6 must not point its gated target at a plain writable data
   source that is still queryable through that generic surface.
2. The Data Factory bridge `data-source:sql-readonly` is intentionally
   source-only. Its host facade exposes only `test/getSchema/getTableInfo/select`
   and rejects writable data-source rows at the read choke point. It has no
   create/update/delete/credential methods.
3. `pipeline-runner.cjs` can already run dry-run versus live mode, and can write
   target results/dead-letters/provenance. But its live path writes immediately
   once `dryRun=false`; it has no cross-request dry-run token, no reviewed
   revision fence, and no external DB target adapter.

Existing PLM stock-preparation table actions already prove a safer apply shape:
server-side action config, dry-run token, revision hash, target-scoped writer,
per-row held/manual-confirm handling, values-free evidence, and entity-machine
re-pull idempotence. C6 reuses that discipline as a pattern; it does not copy
PLM-specific BOM or MetaSheet target logic.

## Non-Goals

C6 does not:

- mutate `data-source:sql-readonly` into a writable adapter;
- expose `DataSourceManager` or credentials to the integration plugin;
- accept raw SQL, stored procedures, CTEs, triggers, or user-provided SQL;
- support delete in v1;
- support arbitrary K3 Save/Submit/Audit/BOM or direct K3 table writes;
- make C5 K3/MSSQL read-only smoke count as write authorization;
- leave a C6 write target reachable through generic raw query, execute, or
  delete routes;
- apply without a fresh dry-run token;
- batch-abort after partially writing without itemized row outcomes;
- auto-retry external writes without an explicit retry policy;
- post credentials, connection strings, SQL text, row values, raw payloads, or
  value-bearing stack traces to evidence.

## V1 Target Contract

Introduce a separate explicit target family, for example:

```text
data-source:sql-write-gated
```

The exact adapter name may be finalized in C6-1, but the contract is fixed:

- role: target only;
- references a `/data-sources` row by `dataSourceId`;
- never copies credentials into `integration_external_systems`;
- requires the referenced data source to be explicitly writable
  (`options.readOnly === false`);
- requires that writable row to be target-only/non-queryable for generic
  `/data-sources/:id/query` style routes, or to carry an equivalent server-side
  capability flag that makes those generic raw-query/delete paths fail closed;
- requires an operator-approved writable database account whose database grants
  are still least-privilege;
- writes only a configured object/table/view-like target;
- writes only configured `writableFields`;
- identifies rows only through configured `keyFields`;
- supports v1 `upsert` by read-then-insert/update through structured adapter
  methods, not raw `MERGE`, `ON CONFLICT`, or vendor SQL strings;
- may later add `insert_only` or `update_only`, but delete remains out of scope.

Example server-owned target config shape:

```json
{
  "kind": "data-source:sql-write-gated",
  "role": "target",
  "config": {
    "dataSourceId": "ds_...",
    "object": "schema.table",
    "keyFields": ["externalId"],
    "writableFields": ["name", "status", "updatedAt"],
    "mode": "upsert",
    "maxBatchSize": 100,
    "maxInFlight": 1,
    "environment": "sandbox",
    "genericQueryDisabled": true
  }
}
```

This is configuration shape only. C6-0 does not add runtime, routes, UI, or
migrations.

## Trust Boundary

The browser may provide only:

- pipeline/action id;
- allowed parameters;
- dry-run token during apply;
- explicit confirmation flags.

The browser must never provide:

- `dataSourceId`;
- credentials;
- target object/table;
- `keyFields`;
- `writableFields`;
- write mode;
- row payloads;
- a dry-run plan;
- a target SQL statement.

All target binding and write scope are server-side/admin-reviewed. Apply must
recompute the plan server-side and compare the recomputed revision with the
stored dry-run token.

## Permissions

Dry-run:

- requires integration read permission;
- may read source rows and read target rows needed to classify
  add/update/skip/conflict;
- never mutates the target.

Apply:

- requires integration write/admin permission from the authenticated user;
- requires a valid, unexpired, single-use dry-run token;
- requires the token's revision to match a fresh server recompute;
- requires the configured target data source to remain writable and visible to
  the server-side authorized principal;
- requires the configured target data source to remain non-queryable through
  generic raw query/delete surfaces;
- must fail closed if any principal/source/target identity is missing.

No path may fall back to tenant, workspace, system, admin, or service identity
when a required principal is missing.

The target data-source principal is deliberately not "who clicked Apply" unless
the route is a direct target test/schema route. For pipeline execution, the
write facade must receive the pipeline owner (`pipeline.createdBy`) as the
data-source owner principal, matching the read bridge's C2a rule. The
authenticated user controls authorization to run/apply; `pipeline.createdBy`
controls visibility to the configured `/data-sources` row. A null
`pipeline.createdBy` is a configuration error and blocks before target lookup or
write.

The dry-run token is principal-scoped. In v1, apply must be performed by the
same authenticated principal that produced the dry-run token unless a later
handoff design explicitly adds delegated approval. The token revision must bind
both the authenticated dry-run user and the target data-source owner principal
used for source/target visibility.

## Dry-Run Contract

C6 dry-run must:

1. load server-owned source and target config;
2. read source rows through the existing source adapter path;
3. transform and validate rows through the existing mapping/validation path;
4. read target rows by configured key fields using structured equality filters;
5. produce a write plan with only counts and row status metadata in the response;
6. create a dry-run token only when the plan is apply-eligible;
7. bind the token to a revision hash that covers:
   - pipeline/action id;
   - allowed parameters;
   - tenant/workspace/project identity;
   - authenticated dry-run user id/email;
   - pipeline owner / target data-source principal (`pipeline.createdBy` for
     pipeline execution);
   - source binding;
   - target binding;
   - target data-source target-only/non-queryable capability state;
   - field mappings;
   - key field list;
   - writable field list;
   - transformed row fingerprints;
   - target lookup fingerprints;
   - plan decisions.

The response must be values-free. It may report counts, operation/status tokens,
field names, error codes, and whether a token is present. It must not report row
values or target payloads.

## Apply Contract

C6 apply must:

1. require `confirm.dryRunToken`;
2. consume the token once;
3. recompute dry-run server-side;
4. reject with revision mismatch if anything changed;
5. write only rows whose decisions are apply-eligible;
6. skip/hold manual-confirm or conflicted rows;
7. isolate row failures;
8. return `succeeded`, `partial`, or `failed` with values-free counts;
9. write dead-letter/provenance for per-row failures and successes where
   attribution is unambiguous;
10. never retry failed external writes automatically in the same request.

`update` must not create on miss unless the decision is explicitly `add` under
the reviewed `upsert` plan. `insert` must not create duplicates when the key
already exists. Delete remains unsupported.

## Failure And Retry Policy

Row failures:

- are itemized by row fingerprint/idempotency key hash only;
- become dead-letter entries with sanitized payloads;
- do not abort clean sibling rows unless the failure is a global configuration,
  permission, target-readiness, or circuit-breaker error.

Global failures:

- missing principal;
- missing target binding;
- target data source not visible;
- target data source still read-only;
- missing key field/writable field config;
- target data source still reachable through generic raw query/delete routes;
- raw-SQL request shape;
- revision mismatch;
- circuit breaker open;
- target schema drift that makes key/writable fields unsafe.

Global failures block apply before any external write.

Automatic retry is disabled in v1. A later retry slice must be token/revision
aware and must prove idempotence with values-free evidence.

## Throughput Guardrails

C6 must protect the external target:

- default `maxInFlight=1` for v1;
- bounded batch size;
- max rows per apply request/job;
- per-target circuit breaker;
- failure-rate trip threshold;
- no unbounded loop over an external target;
- no synchronous large-volume write path that can timeout mid-batch without a
  checkpoint/retry story.

Large-volume external write should use a checkpoint job model, not a single HTTP
request. The large-BOM checkpoint apply path is precedent for job shape, not a
license to skip C6-specific target safeguards.

## Evidence

C6 evidence may include:

- pipeline/action id;
- target kind;
- operation mode token;
- counts: planned, created, updated, skipped, held, failed;
- error code tokens;
- dry-run token present/absent;
- revision match/mismatch;
- idempotence signal (`secondRun.add=0`);
- rollback/re-pull outcome tokens;
- package fingerprint and route names.

C6 evidence must not include:

- credentials;
- connection strings;
- host/database/table values unless already redacted or operator-approved as
  names-only metadata;
- SQL text;
- row values;
- raw payload JSON;
- target request bodies;
- stack traces with values.

## Implementation Slices

### C6-0 - design lock

This document plus the delivery TODO update. No runtime, no route, no UI, no
package, no external write.

### C6-1 - host write facade + latent target adapter

Add a narrow write facade separate from `context.api.dataSources` read facade.
The write facade may expose only structured, bounded methods needed by C6, for
example `lookupByKey`, `insertRows`, and `updateRows`. It must not expose raw
`query`, credentials, adapter instances, transactions, or delete.

Add a latent `data-source:sql-write-gated` target adapter using the facade.
C6-1 exposes only target metadata plus test/listObjects/getSchema. It must not
advertise or implement pipeline `upsert`; the first real write entry point is
C6-3's token-bound apply route after C6-2 proves dry-run/revision behavior.

Required locks:

- referenced data source must be explicitly writable;
- referenced data source must also be blocked from generic raw
  `/data-sources/:id/query`, execute, and delete routes;
- missing principal fails closed;
- pipeline writes pass `pipeline.createdBy` to the write facade, not request user
  and not a default identity;
- direct target test/schema routes pass the request user;
- read-only source fails closed on every write method;
- generic raw-query route against the same configured target fails closed before
  executing SQL;
- raw SQL is impossible by type/shape;
- delete is unsupported;
- adapter metadata advertises target-only write guardrails;
- adapter metadata does not advertise `upsert` or any runtime write operation
  until C6-3;
- a pipeline configured with this target before C6-3 must fail closed rather
  than write externally;
- existing `data-source:sql-readonly` source adapter remains source-only and
  still rejects writable bindings.

### C6-2 - dry-run route

Add a route that recomputes the write plan and issues a dry-run token. No apply
route yet.

Required locks:

- read-only permission can dry-run;
- dry-run performs no write;
- token is not issued for invalid/unready/conflicted plans unless the conflict
  is explicitly held and apply-safe;
- response is values-free;
- client cannot supply target object/keyFields/writableFields/plan/payload.

### C6-3 - apply route

Add token-bound apply.

Required locks:

- write/admin permission required;
- missing token rejected;
- expired/used token rejected;
- revision mismatch rejected before any write;
- apply recomputes server-side;
- client-supplied plan/payload/target binding rejected;
- row failures are isolated;
- dead-letter/provenance emitted values-free;
- no automatic retry;
- target writes stay within configured object and writable fields.

Implemented shape:

- route: `POST /api/integration/pipelines/:id/external-write/apply`;
- request body accepts only `tenantId`, `workspaceId`, and
  `confirm.dryRunToken`;
- route requires integration write/admin permission;
- apply consumes the token once, recomputes the same server-side dry-run plan,
  and rejects revision drift before any insert/update;
- host durable plugin storage exposes atomic token `consume()` (`DELETE ...
  RETURNING`) and the apply helper falls back to an in-process per-token lock
  only for non-durable test/local storage;
- source reads and target writes use `pipeline.createdBy` as the data-source
  owner principal; the authenticated user only authorizes apply;
- per-row write failures emit values-free row error summaries, values-free
  provenance events, and values-free dead-letter entries when the host
  `deadLetterStore.createDeadLetter` capability is present;
- when the route creates a pipeline run, dead-letter and provenance entries use
  that real `run.id` so existing run/provenance/dead-letter lookup surfaces can
  find the C6 row results;
- response is values-free and does not echo the bearer token, row values,
  credentials, connection strings, raw SQL, target payloads, or client-provided
  scope.

### C6-4 - UI

Add a review surface:

- dry-run first;
- show counts/status/error tokens;
- require explicit confirmation;
- disable apply for read-only users;
- do not render row values from external target payloads;
- do not expose dry-run token as copyable evidence;
- reset review when parameters/config change.

### C6-5 - entity-machine smoke

Run sandbox-first validation:

1. configure a writable sandbox SQL target with least-privilege credentials;
2. dry-run and verify no target mutation;
3. apply with token;
4. re-pull/re-dry-run and prove idempotence (`add=0`);
5. validate row-level failure behavior using a controlled bad row;
6. validate read-only user cannot apply;
7. validate rollback/cleanup using operator-local target controls;
8. post values-free evidence.

Only after C6-5 passes can the Release gate discuss production/batch.

## Acceptance Checklist

- [x] C6-0 design merged before runtime.
- [x] New write target is a separate explicit target contract, not
  `data-source:sql-readonly`.
- [x] Existing read-only bridge facade remains read-only by construction.
- [ ] Target config is server-owned/admin-reviewed.
- [x] Credentials stay only in `/data-sources`.
- [x] C6 write target is not reachable through generic raw
  `/data-sources/:id/query`, execute, or delete paths.
- [x] C6-1 target adapter is latent: metadata/test/schema only; `upsert` stays
  unsupported until C6-3 token-bound apply.
- [x] Dry-run is read-only and token-producing.
- [x] Apply requires write/admin permission plus fresh single-use token.
- [x] Revision fencing is hard; mismatch blocks before write.
- [x] Per-row failures are isolated and observable.
- [x] Dead-letter/provenance are values-free.
- [x] No raw SQL, delete, stored procedure, CTE, trigger, or user SQL path.
- [ ] Max-in-flight/circuit-breaker/batch limits protect the external target.
- [ ] Entity-machine smoke proves apply, re-pull idempotence, and rollback
  posture before production.

## Relationship To Release

Before C6-5 passes, the product can be described as:

```text
read-only database connection as a Data Factory source is available
```

It must not be described as full database/system connection delivery. Full
delivery requires C6 write completion plus entity-machine evidence.
