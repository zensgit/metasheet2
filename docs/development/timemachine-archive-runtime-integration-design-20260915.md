# Archive Runtime Integration

Status: DRAFT/HOLD integration; bounded runtime acceptance below, not enablement.

## Completion Shutdown Integration

Clean tested code `4bd71a62834bbee6d3764dd8ff9b16223a102ed0`, tree
`f96027d15689b52756e812dbf800951c6eb02890`, true-merges ordered parents
`126ef8e26cb18f270fc2ab1b04749482e6dd0152` and shutdown candidate
`b171cc34b302ff8ed5ddd96061eb2faa09094bfd` (#5768, including #5758).
The first parent preserves then-current main `a4007e1e37f5aa522b7558a9e90a6f945941bee3`.
Only the preceding main replay required two test-list UNION resolutions;
the shutdown integration itself is conflict-free.

Producer admissions close before awaiting admitted work. Owned completion
subscriptions stay attached until producer and transitive producer drains finish;
then their callbacks drain before the pool closes. Immediate rejection observation
retains the original rejection for the barrier verdict. Restore-worker failure
still forbids pool close. Successful timeout timers are cleared.
The owning shutdown design/verification pair records failure and mutation scope.
This adds no provider selection, capture policy, permissions, or runtime enablement.

## Record Approval Main Replay

True merge `5a8054d48a52b417cef7c99372541300fd776a2c`, tree
`c77f762ad226c3d65c408458776aee372009e20e`, has ordered parents
`5c7f96a7b028414948e1cb673a4b75f6f2ec1576` and then-current main
`784c22dc182b2050bf204f4d013226d5bbb15131`. All 13 incoming paths merged
automatically, including shared client and record-label utilities. No manual
production resolution, migration, workflow, or new recovery semantics were added.
Record approval names/pagination and atomic terminal handling remain main-owned.
Approval completion shutdown, provider/custody decisions, and nightly sample
attribution remain separate open gates; this replay does not close them.

## Embed Echo Main Replay

True merge `0753062239e16cce410714f7083a19bb19e15fac`, tree
`4dfffc3a6fd62970e3d02e5064c689242ec753de`, has ordered parents
`b05fb6a8a61f6fb2f86e6a5254b23d7e42793538` and then-current main
`1bbf3c1c311ffd7dd58e841dd5e9a1c642db7e2c`. Incoming embed-host resolved-context
echoes and automation config roundtrip coverage coexist with TM atomic context
generation. Product merge is automatic; only the two existing Web test lists
require manual union. Both external-context-sync and automation-manager-roundtrip
remain in both lanes. No backend, plugin or OpenAPI change is introduced relative
to the first parent. Provider/custody, nightly sample attribution and the separately
owned approval shutdown P2 remain open; this replay does not authorize enablement.

## Workbench Main Integration

Code `19c6b60ccd4437003f4982308b58e00698dcdf9a` incorporates main
`79dbc6588329b47e237315ea0bb1986625c5b64c` by true merge. External-context
memoization coexists with TM generation ownership: context and fields apply
atomically, superseded requests return false and do not memoize another writer.
Two incoming tests were aligned to this existing contract; no production guard
was weakened. Both Web gates now explicitly collect the new external-context
spec, preserving all parent tokens. The verification report binds the final
459-file required-web run and distinguishes its evidence from earlier runs.
Provider/capture decisions, nightly attribution and the independently confirmed
main-existing record-approval shutdown P2 remain open.

## Record-Approval Backend Integration

Code `ba803089f7990958b23f261229907fd7f3bf58e1` true-merges main
`59d1eac2c943e3ede8990f9521dc0d96207b7bcd` after the frontend replay below.
No manual conflict resolution was needed. Incoming `canSubmitApproval` remains
an AND intersection of request/database capabilities and false in the denied
set; existing recovery authorizations are not widened. Record-approval startup
and durable consumers coexist with recovery application construction/drain.
The combination requires the new 405-migration stream, not the earlier 403
stream. Verification below is isolated and does not enable production features.

## Record-Approval Main Integration

Code `1937ec0e96984f310db034cfab8eac0d26693991`, tree
`e0c6a366e8b54853e0186de7237556a431295a33`, true-merges the verified
`50caab8495fa70e33985ec6ace190ae64eaafbc2` candidate with main
`02808c068d8d5cf60ae9f73a1051b3cdffc6d65b`, in that parent order.
Main adds record-approval UI. Only the domain web guard and required-web script
needed manual conflict resolution: preserve the sheet-trash token and both
record-approval tokens, with zero missing parent tokens. Product files merged
automatically. No backend, migration, provider, OpenAPI or flag semantics changed.
The 109-file TM delta remains relative to this new main. Earlier sections bind
their original checkpoints; fresh publication CI is required for this merge.

## Combined Current-Main Contract

Clean code `5131269ffd5afcc8aa561800910bdb299f4e68df`, tree
`5c72f2df21d143a112d6dbbe52d1a1953eea0bda`, integrates runtime #5744,
recovery UX #5709 (including #5704), and readiness #5725 by true merges.
The final merge's second parent is main
`f67984b34cc170e7256292e671d619502feea0e9`. Its eight automation files have
zero path overlap with the Time Machine candidate. No constituent PR is closed
or merged by this integration; publication reuses the existing #5744 branch.

The user-visible ownership boundaries remain separate:

- Recycle bin restores a retained, soft-deleted whole table with its rows, fields
  and views. It cannot resurrect a physically hard-deleted table.
- Record history identifies the deleted row, its visible field values and named
  actor; selected-record restoration does not restore unrelated rows or schema.
- Configuration history describes typed field/schema changes and viewer-local
  time. Column recovery uses the existing typed restore and captured-value guards,
  not a row-history write pretending to recreate schema.
- Archive recovery requires a verified archive and explicit confirmed preview;
  server-owned durable jobs and derived work remain behind existing authority.

Integration exposed two overlapping asynchronous-context defects. Metadata loads
now bind both a request generation and the selected base/sheet/view. Superseded
results, failures and rollback snapshots cannot replace newer user context, and
an old request cannot clear a newer load's busy state. A background manager poll
must not start while a foreground base-context load is pending; otherwise the
temporary new-base/old-sheet combination could invalidate the user's switch.
Sheet-only and view-only external navigation must also set this foreground busy
state before awaiting metadata, even when the URL supplies no base. The existing
generation-aware finally clears it. Interval and visibility refresh resume
against the selected sheet after navigation.
Cancelled restore refreshes must not toast errors into another selected sheet.

These changes preserve refresh cadence, server permissions, restore semantics,
and default flag behavior. They add no provider selection or deployment policy.
The verification report binds both real-browser chains to this combined code.
Production capture/coverage, durable provider/key custody, operational missing
samples, fresh published-head CI and separate merge authority remain open.

## Real Archive Workbench Acceptance

Code `1907d2b413abbeb65b00e07c917406154f001501`, tree
`72ec5b49e7890421f7e27c9810568e1e6cbae277`, extends the existing manual
standard-server acceptance instead of creating a parallel backend or browser
harness. Parent is `a1d2fe1968c9464de9b7306ac72f07065f380925`; current-main
ancestor is `2b67a04625a0d6b089dac173e47a0de5d111e225`. Two script/config
files change, +137/-5; production source and shared CI wiring are unchanged.

The real LoginView must create a persisted session and navigate through the real
router into MultitableWorkbench. Archive selection and async preview must occur
through its toolbar/modal; the recovery point must use the viewer's timezone.
Confirmation is required before the browser submits the one real job. Reloading
the entire page must rediscover that persisted job through the server, reach
completed progress, and refresh visible grid values. No response stubbing,
manufactured browser token, localStorage injection or test-driven worker tick is
allowed. Independent database checks still prove all 5,001 rows/revisions and
all 5,001 completed derived effects, not just a success message.

Desktop and mobile preview/completion screenshots accompany the local evidence.
Mobile count, progressbar and outcome must intersect the viewport in full and
must not be horizontally clipped. Removing job discovery or shifting the count
offscreen must fail this acceptance. Browser errors, failed API responses and
non-owned network targets remain fatal. Cleanup closes browser and Vite before
the standard server, then drops the owned database and object directory.

`scripts/tsconfig.recovery-archive-acceptance.json` supplies an explicit, committed
TypeScript project for the manual Node/browser script; it does not broaden the
default test project or a required workflow. The script binds its config and two
production UI surfaces in addition to the prior source fingerprints. This closes
only synthetic browser-to-standard-server-to-fixture-provider acceptance.
Production capture, coverage construction, independent provider/KMS durability,
runtime enablement and deployment remain outside this evidence. The older
archive-browser-open wording below is retained as historical checkpoint context.

## Standard Server HTTP Acceptance

Code `54ac563ce3d0d69b1970a986370a6ef6bce5238b`, tree
`bf2184778e308488dc87adcdae05bfa302b458e7`, adds the manual
`packages/core-backend/scripts/verify-recovery-archive-server.mts` acceptance.
The existing verified-archive seed is extracted into a shared test utility;
production source, migrations, providers, workflows and persistent flags are unchanged.

The script must create its own randomly named database on the audited, task-owned
local test cluster, run the complete migration stream and a second replay, and
scrub inherited endpoints and credentials before loading the application.
Only owned loopback ports are admitted. Real password login and persisted sessions
must lead through the canonical archive catalog, preview, accept and status routes.
The standard server must own worker startup and draining; the script must not
invoke a worker tick or replace authorization with an allow-all callback.

Acceptance requires anonymous/reader refusal, flag-off refusal, a non-mutating
async preview, exactly 5,001 restored records and revisions, and complete canonical
derived-effect processing. Restore and derived processing have separate bounded
deadlines. Removing standard-server worker startup must make this acceptance fail.
Evidence binds HEAD/tree, all three scoped file hashes and the tracked dirty diff;
source changes during the positive run are rejected. A new RUNNING marker replaces
old PASS evidence before admission. PASS requires cleanup, including database
disposal, not merely successful requests.

This closes the local standard-server HTTP recovery path for a **seeded encrypted
archive with synthetic custody and test-only local storage**. It does not prove
archive capture/build/upload authority, independent durable storage/KMS across
restarts, archive browser UAT or deployment. Production provider selection and
operational acceptance remain separate. The earlier standard-HTTP-open wording
below is historical and superseded only by this bounded acceptance.

## Current Application Lifecycle Contract

Test checkpoint `34681dc7c326926311dbe5446b22355e8e81100f` exercises the existing
production application composition and actual timer in fresh processes after
both crash boundaries. Resume and derived draining must enter through
`createRecoveryArchiveApplication().startWorker()`, not a test-driven `runOnce`
loop. Canonical authority and transaction providers remain mandatory. Completion
is checked against persisted rows, revisions and the derived ledger. Revocation
must defer derived work without marking it complete.

Stopping must drain the current tick, emit the expected lifecycle, prevent later
run callbacks and release the timer so the child exits normally before pool
disposal. Omitting timer cancellation must fail acceptance. These tests keep
synthetic custody and parent IPC storage; they do not choose or approve a
production provider. Full standard-server HTTP startup remains separate.

The following chronological checkpoints retain their original local evidence
and open-gate wording; later exact checkpoints supersede only the corresponding
bounded acceptance, not all runtime/production readiness.

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

### Bounded Derived Drain

Code `5522d0467e17c43eeafb910854d63bde2973b2c6` replaces the one-effect-per-timer scheduling limit with at most 32 sequential completed effects per tick before normal restore selection. Idle or retry ends the batch immediately; stop is checked between effects and after the batch. Infrastructure exceptions retain the existing failed-tick behavior. No new parallel transaction, permission, flag or retry semantics are introduced. The internal count is a fairness bound, not a throughput SLA or a time limit on one processor call. Pending-index and pool-capacity validation remain necessary.

### Pending Queue Index

Code `027ff1ef7309306e88ce3d4797da3658b1298812` adds a partial btree index matching the existing pending-effect ordering (last attempt NULLS FIRST, creation time, revision) and completed-at-NULL predicate. The unpublished ledger migration owns its creation and exact definition/validity/readiness audit. Wrong predicate, column order or NULL ordering is rejected rather than silently accepted by IF NOT EXISTS. This does not change queue eligibility or authorization. Pool-capacity remains open: consumer and processor use separate simultaneous transactions; the main pool defaults to 20 but is configurable, so default capacity is not sufficient acceptance proof.

### Canonical Derived Drain After Process Restart

Test code `0f5e1176a4adc74afa26a6ac769af1982eb66892` replaces the terminal identity-only processor in the two actual process-kill cases with the canonical derived processor. Each case proves an inactive actor leaves all 5,001 effects pending and computed data unchanged; reactivation permits all effects to complete and formulas to reflect restored inputs. Draining occurs in the parent test process, not the restarted child's full worker scheduling loop. Object-store/key custody remain fixture implementations; standard provider startup and deployed acceptance remain open.

Code `04b63fd732ecb33c90cc07e2767cebc4630a8647` declares the scoped derived SQL's existing lock/revision disposition. Computed-value refresh is not an authored edit and emits no extra record revision or version increment. This annotation does not waive the archive processor's actor authorization, authority lease, transaction scope or canonical sheet fences; no SQL or runtime behavior changes.

### Fresh-Process Worker Drain Acceptance

Test code `7e451b46b14859eadd4e5dd3a015799cb22efc07` advances the preceding parent-process acceptance to independent child processes using `createRecoveryArchiveRestoreWorker` and canonical derived authorization/calculation. The drain fixture supplies two pool connections because the queue lease and canonical processor own separate transactions. Each `runOnce` is measured: 156 batches of 32, then 9, then 0; an inactive actor consumes no effects and does not hot-loop within the tick. Production runtime is byte-identical. This closes the derived worker-factory/runOnce composition gap after actual restore-process crashes; it does not claim standard server startup, timer lifecycle, production custody/object-store configuration, or deployed browser acceptance.

### Production Worker Resume Acceptance

Test code `7d6d230c68720b5dc0bc679fb6a8d86fe6b09206` removes manual claim/chunk/finalize orchestration from the fresh-process resume path. The production worker now selects, claims, applies, renews and finalizes the retained job. A crash before commit requires two resumed chunks; a crash after commit/before acknowledgement requires only one. Serialized old claims remain rejected. Terminal state is read independently from the database, not inferred from the worker result. The crash injector still uses a transaction barrier around the production chunk executor; key custody/object store remain isolated fixtures. No production implementation, recovery semantics or deployment settings change.

### Full-Schema Test Fixture Ownership

Test-only code `3409c5f92b7622cb4b683ffe5e74c4e7186176ba` updates older archive fixtures for the existing derived-effect ledger's restrictive job FK. Cleanup uses an explicit archive-owned table allowlist and includes the child only if the relation exists. It never uses TRUNCATE CASCADE or discovers unrelated tables to delete. Older partial-schema fixtures remain valid.

Catalog migration rehearsal preserves the optional child topology: empty child down precedes job down; job up precedes child up. The positive replay checks that the originally present child exists again before intentional transaction rollback. Production nonempty-down refusal, migration authority checks, immutable effects and restrictive FKs are unchanged. The change repairs test setup/teardown on the combined 403-migration tree, not restore behavior, provider selection or runtime enablement.
# DingTalk Mirror Lifecycle Integration Checkpoint

Code `79228def7c8f5d8e82588381ff21a4995f2ffb89`, tree
`854e01b7331d499d4b894a8477d4bd2ff53ad971`, true-merges prior TM head
`32e517b2766b06ee5a32f4452accffebc3f112fa` with owning lifecycle fix
`c787f644fe19964eff67f3b1836ef3c1333c5e7d`. The latter includes main
`0be3f25da4eeacfda0ad9144c70ab348633dbf91` as its second parent.

Incoming main added a mirror consumer and delivery worker outside the existing
completion shutdown barrier. The owning fix now retains subscription IDs and
in-flight callbacks, closes admission and drains the worker before shared pool
closure. The existing recovery worker shutdown and producer/transitive-producer/
consumer order are preserved. This does not enable DingTalk or authorize sends.

The only manual conflict is MultitableWorkbench.vue: keep SheetTrashModal's
base-scoped whole-table recycle-bin contract, not main's old record TrashModal.
The incoming view-manager/archive null-sheet conditional mounts are retained.
The base toolbar can still open whole-table trash without an active sheet.
No hard-deleted table resurrection, provider choice, capture policy, flag or
deployment semantics are added. Fresh combined-head CI remains required.
