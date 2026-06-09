# Data Factory #2342 - C3 large-BOM job skeleton verification (2026-06-08)

## Scope

This slice implements only the C3-1/C3-2 job skeleton for large-BOM background
expansion:

- durable job-store contract;
- queued background expansion job creation;
- values-free inspect response;
- cancel transition for a queued job.

It does not implement C3 checkpointed expansion, C3 authoritative artifacts,
C4 checkpointed apply, PLM/external writes, K3 writes, source reads, target
record reads, or MetaSheet row writes.

## Runtime Contract

Routes added:

- `POST /api/integration/table-actions/:actionId/large-bom/expansion-jobs`
- `GET /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId`
- `POST /api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/cancel`

The start route accepts only `{ parameters: { projectNo } }`. Browser-supplied
source, target, read plan, SQL, caps, plan, payload, sheet id, field id, or
token fields are rejected at the route boundary.

Background expansion requires `context.storage.durable === true`. A regular
memory store fails closed with `LARGE_BOM_JOB_STORE_UNAVAILABLE`, because it
cannot satisfy resume semantics.

The start/cancel paths require an authenticated principal. Missing `user.id` /
`user.email` fails closed with `LARGE_BOM_JOB_PRINCIPAL_REQUIRED`; there is no
system/admin/service fallback.

## Values-Free Evidence

Public job responses expose:

- opaque `jobId`;
- status and `largeBom=true`;
- `projectNoPresent`;
- progress counters;
- source kind token;
- values-free error/read-shape tokens.

Public job responses do not expose:

- project number;
- principal;
- source external system id;
- target sheet id or field ids;
- PLM rows;
- target rows;
- read filters or filter values;
- raw SQL;
- credentials, tokens, or connection strings.

## Verification

Commands run:

```sh
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:http-routes
```

Assertions locked:

- memory-only storage is rejected before source load, adapter creation, target
  reads, or target writes;
- durable storage permits a queued job;
- inspect returns a values-free queued job;
- read-only users cannot cancel;
- cancel rejects browser-supplied scope fields;
- cancel transitions the job to `cancelled` without making it authoritative;
- helper-level lifecycle responses remain values-free even though private job
  state stores the project parameter and principal for future worker resume.

## Deferred

The following remain separate gated slices:

- C3-3 checkpointed expansion and resume;
- C3-4 authoritative artifact/planner handoff;
- C3-5 entity-machine validation;
- C4 checkpointed apply.
