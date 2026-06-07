# Data Factory #2342 C3 - large-BOM background full-expansion design (2026-06-06)

## Scope

This is a design-only slice for the #2342 large-BOM lane.

It defines how a PLM stock-preparation table action should perform a complete,
authoritative BOM expansion when the synchronous dry-run lane returns the C1/C2
bounded state:

- `status='large_bom_bounded'`;
- `largeBom=true`;
- `boundedPreview.complete=false`;
- `canApply=false`;
- no dry-run token.

C3 adds no runtime, route, UI, migration, package, worker, queue, MetaSheet row
write, PLM write, external database write, K3 path, C4 Apply, or production
rollout. It is the contract that a later implementation must satisfy before
large samples can produce authoritative C3 duplicate/conflict evidence.

## Current grounding

The current synchronous path is intentionally bounded:

- `expandPlmProjectBom` performs app-side recursion over flat, parameterized
  adapter reads.
- The expansion helper has hard caps for rows, read pages, read attempts, read
  elapsed time, and depth.
- C1 distinguishes scale-class bounded failures from hard correctness/source
  failures.
- C2 renders the bounded state and keeps Apply disabled.
- `dryRunStockPreparationAction` issues a dry-run token only when the plan is
  applyable.
- `applyStockPreparationAction` recomputes C2/C3 server-side before C4 writes.

C3 must preserve that posture. It must not turn a large BOM into a longer
single HTTP request, and it must not make a bounded subset look complete.

## Decision

Introduce a separate background full-expansion lane.

The lane is for complete, authoritative expansion only. It does not apply rows.
It produces a completed expansion artifact that later slices can feed into:

1. a full C3 conflict/duplicate planner;
2. C4 checkpointed apply design and implementation.

The synchronous lane remains the first operator signal. A bounded synchronous
dry-run can offer "start background full expansion" only when a server-side
large-BOM policy enables it. Browser input must not raise caps or switch apply
mode.

## Hard invariants

- Read-only: C3 performs source reads and target existing-row reads only.
- No Apply: C3 creates no MetaSheet rows and patches no MetaSheet rows.
- No PLM/external write, no K3, no Submit/Audit/BOM write path.
- No raw SQL, recursive CTE, stored procedure, vendor API, JavaScript, URL, or
  browser-supplied query body.
- Source reads continue through the configured source adapter:
  `data-source:sql-readonly` or `bridge:legacy-sql-readonly`.
- Recursion remains app-side over flat equality reads unless a separate source
  gate pivots to a customer flat BOM view or deferred PLM adapter/API track.
- The authenticated request principal must be captured and used for source
  reads. Missing principal fails closed. There is no system/admin/service
  fallback.
- Source binding, read plan, target binding, caps, and approval policy are
  server-side action config/policy. The browser sends only allowlisted
  parameters and a request to start or inspect a job.
- Job/checkpoint storage must be durable. Memory-only storage is forbidden for
  background full-expansion mode because it cannot satisfy resume semantics.
- Public evidence is values-free. Tenant runtime state may store PLM values
  internally, but issue/customer evidence must expose counters, states,
  fingerprints, and error codes only.

## Background job lifecycle

Future implementation should model C3 as a job, not a synchronous route.

Suggested lifecycle:

| Status | Meaning | Authoritative? | Apply token? |
|---|---|---:|---:|
| `queued` | Accepted, not yet reading. | No | No |
| `running` | Expanding with checkpoints. | No | No |
| `paused` | Resource/policy pause, resumable. | No | No |
| `failed` | Hard error or exhausted background budget. | No | No |
| `completed` | Full expansion completed and artifact sealed. | Yes | No |
| `cancelled` | Operator/admin cancelled before completion. | No | No |
| `expired` | Artifact exceeded retention. | No | No |

Only `completed` may be treated as authoritative for duplicate/conflict
analysis. Even then, C3 still does not write. C4 checkpointed Apply remains a
separate opt-in.

## Future route shape

The exact route names are deferred, but the contract should be:

1. `POST` start background expansion.
   - Requires Data Factory read access plus server-approved large-BOM policy.
   - Uses `requestPrincipal(req)` or the equivalent authenticated principal.
   - Accepts only `{ parameters: { projectNo } }` and maybe an action id from
     the path.
   - Rejects browser-supplied source, target, read plan, cap, SQL, C3 plan,
     C4 payload, dry-run token, sheet id, or field id.
2. `GET` inspect job progress.
   - Returns values-free progress/evidence.
   - Does not return raw expanded rows for issue evidence.
3. Optional `POST` cancel job.
   - Requires the same tenant/workspace/project scope and appropriate access.

The implementation may additionally provide a tenant-only row review endpoint,
but issue/customer evidence must remain values-free.

## Checkpoint model

The current recursive helper keeps traversal state in process memory. C3 needs
that state represented explicitly.

Minimum private checkpoint state:

- job id and action id;
- tenant/workspace/project scope;
- authenticated read principal;
- server action config revision;
- allowlisted parameters and a private parameter hash;
- source binding and target binding revisions;
- read plan revision;
- background budget policy;
- frontier/work queue;
- completed row chunk manifests;
- read diagnostics;
- error summaries;
- started/updated timestamps.

Frontier entries should be explicit enough to resume app-side recursion:

- relation step or object being read;
- filter field names and private filter values;
- cursor/page state for the active flat read;
- parent source id;
- component source id;
- source version when relevant;
- path tokens;
- depth;
- cumulative quantity;
- active flag.

The private checkpoint can contain tenant row values because the tenant runtime
needs them to finish expansion and planning. Public evidence must not expose
those values.

## Duplicate-safe resume

Resume must be idempotent.

The worker must not append duplicate expanded rows when it retries a partially
completed read or restarts after a checkpoint. Acceptable implementation
patterns include:

- deterministic row keys with upsert-by-key into the job artifact;
- chunk sequence plus chunk content hash, with retry replacing the same chunk;
- task completion markers that are written atomically with the produced row
  chunk.

A future test must prove this negative control: interrupt after a row chunk is
persisted, resume the job, and verify the final artifact has one copy of each
expanded row.

## Durable storage requirement

Background expansion is only allowed when the runtime can provide durable job
storage.

The implementation can use a DB-backed plugin storage, a core job table, Redis
with configured persistence and retention, or another reviewed durable store.
It must fail closed if the available storage is only process memory.

Retention must be explicit:

- private expanded-row artifacts expire;
- public job summaries can live longer if values-free;
- expired artifacts cannot be applied by C4.

## Budget model

C3 uses separate background budgets. It must not reuse the small synchronous
lane caps as the only control, and it must not accept caps from the browser.

Minimum server-side budget fields:

- max rows;
- max read pages;
- max read attempts;
- max elapsed time;
- max depth;
- max artifact bytes/chunks;
- max concurrent jobs per tenant/workspace/action.

Scale budget exhaustion in the background lane is still fail-closed:

- status becomes `failed`;
- no authoritative artifact;
- no Apply token;
- evidence reports values-free error types and counters.

`max_depth_exceeded`, `cycle_detected`, invalid quantities, source read
failures, and adapter failures remain hard failures, not "large BOM" successes.

## Progress and evidence

Public progress should be values-free:

```json
{
  "jobId": "opaque",
  "actionId": "plm.stock-preparation.pull-bom.v1",
  "status": "running",
  "largeBom": true,
  "authoritative": false,
  "projectNoPresent": true,
  "progress": {
    "rowsExpanded": 12000,
    "readCount": 24031,
    "frontierRemaining": 87,
    "completedChunks": 19
  },
  "evidence": {
    "sourceKind": "data-source:sql-readonly",
    "readObjects": ["DN_PDM_BomDetailsInfo"],
    "errorTypes": [],
    "readDiagnosticShapePresent": true
  }
}
```

Issue/customer evidence must not include:

- project number;
- PLM row values;
- component code/name/material/source ids;
- target row values;
- sheet ids or field ids;
- raw filters or filter values;
- raw SQL;
- credentials or Bridge secrets;
- dry-run/apply tokens;
- private checkpoint payloads.

If a fingerprint is exposed, it must be deterministic for correlation and
non-reversible in practice, for example a server-keyed digest. Unsalted hashes
of project numbers are not acceptable issue evidence.

## Completion artifact

A completed job must seal an authoritative expansion artifact:

- expansion status is complete;
- all frontier work is done;
- no scale cap/hard global error is present;
- read diagnostics are finalized;
- expanded row count is final;
- artifact revision is computed from action config, parameters, source binding,
  read plan, expanded rows, and target binding revision.

Only this completed artifact can be used for authoritative #2343 duplicate
analysis on large samples. Bounded C1/C2 counts remain subset-only.

The C3 implementation may either:

- run the existing conflict planner immediately after completion and store a
  values-free plan summary; or
- expose the completed artifact to a later planning step.

Either way, C4 Apply remains separate and must not be unlocked by C3 alone.

## Relationship to C1/C2

C1/C2 are still useful after C3 exists:

- sync dry-run gives fast feedback;
- bounded state tells the operator why the sample needs the background lane;
- `largeBom=true` still blocks normal Apply;
- the UI can offer background start only when server policy allows it.

The bounded preview must continue to label C3 counts as non-authoritative.

## Relationship to #2343 duplicate handling

#2343 D1 can be validated on already-complete samples such as the #2340 246-row
case. For large samples, D1 duplicate policy must wait for C3 completion.

Before C3 completes, duplicate diagnostics are not authoritative. After C3
completes, duplicate evidence can rely on the full artifact.

The duplicate handling design should never silently drop duplicate demands.
Any keep/merge/source-correction decision must be explicit and values-free in
evidence.

## Relationship to C4 checkpointed apply

C3 does not write.

C4 should consume only:

- a completed C3 artifact or completed full plan;
- an explicit large-BOM owner approval;
- a fresh revision binding;
- a checkpointed writer design.

The normal C5 dry-run token is not enough for large-BOM apply by itself. Large
apply needs its own checkpointed approval/execution contract.

## Implementation slices

Suggested future decomposition:

1. **C3-1 storage contract:** durable job store, values-free public projection,
   retention, fail-closed memory-store rejection.
2. **C3-2 worker skeleton:** start/inspect/cancel job, capture principal and
   server-side action config, no row writes.
3. **C3-3 checkpointed expansion:** explicit frontier, paged flat reads,
   duplicate-safe resume.
4. **C3-4 authoritative artifact/planner handoff:** completed artifact revision
   and full duplicate/conflict evidence.
5. **C3-5 entity-machine validation:** large sample proves complete expansion,
   resume after interruption, values-free evidence.

C4 checkpointed Apply design remains a separate follow-up after C3 design.

## Acceptance locks for future C3 implementation

- Starting a background job without a real authenticated principal fails
  closed; tests must prove no system/admin fallback.
- Browser-supplied caps/source/target/read plan/SQL/plan/payload are rejected.
- Memory-only job storage is rejected for background full-expansion mode.
- No raw SQL, CTE, stored procedure, or vendor API path is introduced.
- Source reads use the same server-configured source binding and read plan.
- Scale budget exhaustion never produces an authoritative artifact.
- Hard failures stay hard and do not become `largeBom=true`.
- Public progress/evidence is values-free.
- Resume after interruption does not duplicate expanded rows.
- Bounded C1/C2 duplicate/conflict counts are never marked authoritative.
- C3 completion alone does not write rows and does not unlock C4 Apply.
