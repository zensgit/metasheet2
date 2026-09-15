# Archive Runtime Integration

Status: LOCAL INTEGRATION IN PROGRESS. Not runtime acceptance or enablement.

## Frozen Inputs

- Main: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`, verified with GitHub REST on 2026-09-15.
- Actor authority: PR #5735, `dde094922da92845856f761ab0144f2ad9471d36`.
- Explicit read authority: PR #5737, `fd88ca719614e587c9e7aef8628b8419b0115ed5`.
- Persisted worker identity: PR #5727, `a9c1a42112338b74eac2ca28c5c93bed81a0a1ea`.
- Combined code: `22d9fbcd6eefcfc752e953a79b9cf96341dd2836`.
- Combined tree: `756d1e7152ad4a2b732ae68525f5b8dda582cf7f`.

## Contract

Commit-effects checkpoint `77fa2e3d85a0fba5b734d86a9b6fa56666645667` (tree `6360456c6bc41512b4770ad2a51efd68224ad05a`) adds an optional worker `afterCommit(identity, mutations)` port. It runs only after a newly committed chunk, never after rollback, already-committed replay, or no-pending result. Transaction callback retries reset accumulated mutation facts. Effect failures log a fixed values-free code and do not rewrite committed status. Application dependency snapshots preserve this callback. Durable events must still be enqueued inside `onMutationApplied`; this best-effort port is not a durable delivery guarantee, and a process crash after COMMIT may lose the notification. Actual production event/formula/realtime handlers and provider startup composition remain to be connected and verified.

Reuse existing recovery authority rather than implementing a permissive worker substitute. HTTP retains its request/database intersection. Background work must resolve the persisted actor from fresh database state and bind the persisted workspace/base/sheet to live scope. An invalid account cannot regain access through a surviving sheet grant.

Full-table readability includes row restrictions, field scopes, and transitive foreign-field/base formula masking. Write authorization must additionally enforce the true delta's row edit/delete, field write, person membership, and forward-link target rules inside the fenced transaction. No cached JWT reconstruction, allow-all callback, or new grant semantics is acceptable.

The three inputs are true-merged without rewriting their history. The sole manual resolution preserves both independently added exact-anchor real-DB test blocks, unchanged. Original branches and PRs remain untouched.

## Remaining Runtime Work

Shared-policy checkpoint: `5fb07a51126aa228bf635b9d2d49d62720af4c00`, tree `e429ed6710cd948da1c0bd45826a069e4b1c0930`. `recovery-plan-authorization.ts` owns the existing authorization stabilizer and true-delta evaluator. HTTP delegates to it using its unchanged request/database resolver and full-read evaluator. The shared evaluator accepts transaction-bound authority/full-read functions; callers must not provide permissive substitutes.

Worker-adapter checkpoint: `6185c4b39e49214643ced708ce60abfc605e926d`, tree `420890aec4d0775297ca2b681cc5cf740a29f119`. `createRecoveryArchiveWorkerAuthorization` binds the canonical full-read implementation without creating a Request. The new adapter compares persisted base/workspace/sheet identity with live non-deleted sheet/base rows, loads database-fresh actor authority on each read, and delegates true-delta/stabilization rules to the shared module. It rejects mismatched actor/sheet contexts and final lock scopes missing the source sheet. No tenant is inferred from the persisted identity. Provider/application composition and mutation/post-commit hooks remain unwired; this checkpoint does not enable the worker.

1. Share the existing full-read and true-delta evaluator between HTTP and worker without changing HTTP behavior.
2. Bind background identity to live scope; do not invent an authenticated tenant from a request-shaped object or unverified input.
3. Compose canonical mutation/outbox and post-commit effects; preserve cancellation, lease fencing, and writer-block cleanup.
4. Integrate existing provider-preflight/process-restart work without duplicating their implementation; verify the full combined candidate.
5. Validate standard startup with real provider boundaries and synthetic isolated acceptance before claiming runtime readiness.

Whole-sheet hard-delete resurrection, flags, dispatch, deployment, production and customer data remain outside this work. Ready/merge requires separate authorization. Existing constituent evidence is not combined runtime proof.

### Shared Mutation Events

Code checkpoint `9062f3144355e99798c0d505e939f6f54152bdba`, tree `f68b51dd5e8ef2bf042700fb8d32e2812b989dd3`, extracts the existing HTTP event builder into `recovery-mutation-events.ts`. HTTP and worker hooks use the same canonical producer, supplied transaction query, event family and payload. The transaction marker is not authority: the existing durable producer still probes the transaction. Worker hooks retain the same event ID until commit and reject a mixed/unbound identity batch before emitting anything. Durable delivery suppresses the legacy bus; disabled delivery preserves the legacy post-commit path. Failed enqueue never creates an emit-ready entry.

These hooks are not yet assembled with standard application providers and post-commit formula/realtime effects. This is a local integration checkpoint, not completed runtime delivery.

Real-DB follow-up `745b5685626490426d8cd71164df3d0be02e23b9` proves the extracted producer's commit/rollback atomicity and autocommit refusal. It does not change the outstanding application composition contract or authorize enabling durable delivery outside the isolated test process.

### Requestless Computed Effects

Checkpoint `7e37fadb2c50e041178f60c10bb7be82a131ca14`, tree `9c7ef5473e68541f855de44dc62c0e0bbe737520`, adds explicit resolved-access propagation through lookup/rollup hydration, relation aggregation, formula recompute and dependent-record recompute. HTTP callers keep their request path. `createRecoveryComputedHelpers` accepts a resolved actor, rejects an absent actor, and does not manufacture a Request. The caller must obtain database-fresh authority and verify recovery scope before invoking it; the factory itself does not grant or refresh permission.

The real-DB test exposed a pre-existing mismatch: recompute could discover an expression dependency absent from `formula_dependencies`, while taint only consulted that table. The taint graph now unions authoritative expression references with indexed dependencies, so a denied foreign input cannot be persisted as a degraded formula value through that fallback. This is reduce-only; indexed dependencies are retained. Standard worker composition remains open.

### Canonical Worker Callback Assembly

Checkpoint `467b80a239c81b58e1e44a1ec4336c5ef7ab3aef`, tree `452dd5beac6309a01a55de006a1a231fe368a7cf`, exposes `createRecoveryArchiveWorkerCallbacks`. It combines canonical authorization and transaction-bound mutation events with shared HTTP post-commit recompute/notification behavior. HTTP uses the same moved implementation with its original request helpers. Background callbacks resolve fresh authority and live scope before recomputing; revoked authority receives only ID invalidations, not value reads or formula writes. No fake Request or caller-provided allow-all policy is used by this factory.

Remaining lifecycle issue: the chunk callback precedes job finalization, while the long-lived writer block is released by terminalization. Derived writes respect that block. These callback tests deliberately prove composition without an active job block and cannot establish full job completion effects. Terminal/restart-safe derived recompute and standard provider startup remain required; do not wire this as fully ready until that gate is closed.

### Terminal Derived Work Contract

The next internal reliability mechanism is an ID-only derived-work ledger, not another restore snapshot or an authority bypass. A source mutation must enqueue its revision/job/record/field IDs and link invalidation IDs in the same transaction. It must not persist the mutation's user-value patch. Revision identity deduplicates work; a foreign key retains its existing durable job identity.

Consumption must wait for a terminal committed job (`done` or `abandoned_partial`) and use live inputs, database-fresh actor/scope authority, and canonical derived-write fencing. A revoked actor or a conflicting writer block must not be treated as successful recomputation. Successful computation may be retried after a crash, but must not replay the restore mutation or duplicate its business event. Completion is recorded only after all required derived work succeeds; best-effort helpers that swallow errors are insufficient proof. Pending work must be restart-discoverable and bounded per worker tick.

The initial migration checkpoint only establishes the ledger's columns, immediate primary/foreign keys, replay drift audit and nonempty-down refusal. Enqueue, terminal selection, strict completion handling, worker lifecycle integration and blocked-job/restart real-DB evidence remain open. No application path uses the new table yet. This internal mechanism implements existing derived-value recomputation, not a new recovery scope, permission, or feature flag.

The follow-up enqueue primitive probes an actual database transaction and requires an applying job matching all persisted workspace/base/sheet/actor identity fields. It explicitly projects only revision/record/field/link IDs; deletion keeps link invalidations with an empty source field list. Repeated identical revision work is accepted, while different ID payloads for the same revision reject and roll back the transaction. This primitive does not replace job lease/authorization fences and is not exposed as a public endpoint. Production callback wiring waits for the terminal consumer, so the new table is not yet populated by the application.

The terminal consumer attempts at most one pending row per invocation, selecting only `done`/`abandoned_partial` jobs with a currently nondeleted, unblocked source sheet. It holds only the queue row lock (`SKIP LOCKED`) while processing; it must not hold a sheet fence across nested canonical derived writes. The selection's block check is only a prefilter, not authorization or race protection. The real processor must freshly authorize, recheck scope and retain the canonical fence at each write. Exact `true` completes work; false, exceptions or malformed persisted ID payloads remain pending with an attempt timestamp. A crash before queue completion leaves work retryable, so processors must recompute idempotently from live data and must not replay business events. The queue primitive never logs/persists adapter errors.

This consumer is not yet connected to the worker or to a strict computed processor. Existing best-effort formula/related helpers can skip writer-blocked work; those outcomes must be distinguishable before production wiring. Actual process-death/restart, timeout/shutdown, new-block races and runtime composition are still required gates.

### Strict Computed Completion

`createRecoveryComputedHelpers(access, true)` now requests complete computed writes. The shared source/related formula paths reject unavailable formula authority, refused pure-formula materialization, and writer-blocked relation aggregation rather than returning a benign empty result. Related base/sheet read denial is also a failed strict attempt. Default calls retain the prior skip behavior; HTTP factory arguments are unchanged. Canonical derived-write transactions and existing read/taint checks remain the authority, with no writer-block bypass.

This opt-in helper is necessary but not sufficient for a durable work processor: fresh scope/actor resolution, explicitly retained link invalidations after deletes, ID-only notifications, queue/worker binding and restart verification still need assembly. No standard application path enables the strict mode yet.

### Canonical Derived Processor

The requestless processor factory now binds live source identity/full-read authorization and strict helpers. It resolves every explicitly retained invalidation sheet before materializing, preserves same-base sheet authority, and adds canonical base-read checks only for cross-base targets. It recomputes from current rows and current link tables; saved invalidation IDs reach surviving related records even after the deleted source and its edges are gone. Derived notifications contain only IDs, not restored patches; the processor neither recreates records nor emits recovery business events/subscriber notifications again.

The initial test exposed an over-restrictive base-read requirement on same-base work. That requirement was removed in favor of existing same-base/cross-base semantics; no new permission is introduced. A denied explicit related scope causes retry before materialization. This does not authorize privileged computation for revoked actors.

This factory remains unconnected to the application/queue. Before runtime completion, verify the queue-to-processor transaction/lifecycle binding, concurrent authority or input changes between reads and canonical derived writes, bounded shutdown, and actual process restart. Current tests prove pre-existing revocation/block handling, not all read-to-write races. Existing constituent restart/provider PRs must still be integrated without duplicate implementation.

### Durable Runtime Wiring Checkpoint

Code `a4436047b0f98c8e0bcc081850ec67c97fc90a5a` supersedes the preceding unwired status for the async facade and worker components. The facade always enqueues ID-only derived work in the source mutation transaction, before optional event hooks. Enqueue or later hook failure rolls back both source mutation and queue row. The canonical worker callback factory now supplies the previously verified derived processor; enabled application composition requires and snapshots that processor before resolving the database. Flags-off remains inert.

Each worker tick checks stop before sweep, attempts one eligible derived item after sweep, checks stop again, then selects ordinary restore work. Retry does not prevent ordinary job progress; an infrastructure exception at the queue boundary returns a closed tick failure. Existing application stop awaits the in-flight tick. Standalone low-level worker operation fixtures may omit the processor; enabled application composition may not.

This is component wiring, not standard-server/provider or complete restart acceptance. Required remaining gates include concurrent input/permission change between calculation reads and writes, bounded queue throughput/pending index, actual process restart with canonical providers, standard startup integration, and current-main replay. One item per tick is currently a correctness bound, not a claimed large-restore performance target. No flag or deployment is authorized by this checkpoint.

### Commit-Held Derived Inputs And Authority

Code `909afa204a72bd989c77a8203c5b823db37ccac9` adds an archive-only transaction scope. It discovers the source/current-neighbor write surface plus saved delete invalidation sheets, includes their declared/current relation inputs, takes canonical fences in sorted order, and rechecks discovery before calculation. Scope expansion refuses instead of acquiring a late out-of-order fence. Live base/sheet rows are SHARE/NOWAIT-locked; the canonical actor/role/group authority lease is held through commit. No privileged replacement actor or new read permission is introduced.

The scoped query is registered only for the callback lifetime. Existing derived merge sites join that transaction only for this registered query and refuse writes outside its prelocked sheet set. Ordinary HTTP queries retain their existing independent per-record derived transactions. This avoids both stale read-to-write gaps in the archive path and self-deadlock from opening nested fenced writes. Realtime/Yjs notification is deferred until the processor transaction commits; failure remains retryable at the queue boundary.

Evidence covers canonical source/foreign writers and actor lifecycle revocation, pre-existing denied/block conditions, autocommit refusal, out-of-scope refusal and commit failure. It does not claim safety for raw SQL bypassing canonical writer contracts or privileged live DDL. Queue throughput/indexing, connection-capacity bounds (consumer and processor currently use separate transactions), real process restart, provider/standard startup and current-main integration remain delivery gates.

### Existing Provider And Restart Integration

Code `378190bc0f014b05f2364c06cc88fe34d26aa4a9` integrates main `3af8f12f73feedd517bfe97a92697cb1bb15536d`, provider preflight candidate #5726 and process-restart candidate #5728 through ordered true merges. Only the restore-jobs integration spec required manual union: mandatory durable enqueue/rollback and queue cleanup remain alongside both real child-process crash boundaries. No existing PR is replaced or published by this local checkpoint.

Actual SIGKILL before and after first-chunk COMMIT now has combined durable-queue evidence. This supersedes the absence of real process-death testing, not the broader end-to-end acceptance gate: the child still uses fixture authority callbacks and parent IPC object storage, while canonical authority/calculation has separate real-DB evidence. Production provider/custody selection and standard server composition remain explicit open decisions. Test-only storage is not a production default. Queue capacity/throughput and combined canonical restart acceptance remain open.
