# EP01 D03 ready-caller DST proof — Draft

Refs #4556. Preserve the finite parent CALC11 cases: internal gap, earlier fold start, later fold end, shared ambiguous fold boundary. No new calculator, timezone policy, correction target or effective-day rule.

The required fold-start and fold-end cases must use their exact two segments and four punches across live, explicit punch-detail import, frozen_prior, bounded approved overtime and a second frozen_prior. Independent literal totals are 165 (15+150) and 195 (135+60), with exact UTC instants, offsets, fold choices and reasons. Import retains all source ordinals; bounded overtime stays inside an existing segment and cannot inflate physical minutes.

Gap and shared-fold must retain dst_gap_local_time and dst_fold_shared_boundary_ambiguous. Ordinary recompute's retired-parent and completed-prior requirements stay intact; review/refusal cannot count as completed parity or receive fabricated pointers.

Gates: all original test call text/budgets retained; new native full fold chains; gap/shared-fold typed-refusal characterization; matching fold/evidence counterfactuals and exact restore; same-path lint baseline introduced0; affected types/validate:all; independent source review; Draft and current-head actual CI. Filtered/skip/TODO are not passed. Four ready callers do not close correction/CALC14. The original proof-only candidate exposed a real public input/admission limitation; the named amendment below authorizes only the new explicit import contract and its necessary implementation. No dependency/flag/config/provider change; no merge/deploy/R71/tag/release. Owner/manual/live acceptance stays independent.

## Human-approved punch-detail import amendment

Direct user approval on 2026-10-28: “批准具名扩展，仅做 Draft（建议）”. The former daily-record-only contract remains unchanged. This amendment permits a separate explicit input discriminator `inputKind: "punch_events_v1"` and physical-event evidence for the complete finite multi-segment/DST cases. It does not authorize any deployment, merge, R71 change, flag enablement, or final owner acceptance.

The closed business input contains inputKind, userId, workDate, timezone, and punches. Each punch contains only direction (check_in/check_out) and a canonical UTC occurredAt instant. Authenticated organization, actor, token, idempotency, policy and context remain server-owned or governed by their existing transport rules. Unknown variants and extra business fields are rejected; they must never fall through to the old daily parser. No normalization to an outer first/last pair or fake per-row daily minutes.

The existing shift/reference-calculator bound is three segments, so this bounded format admits one through six strictly chronological, alternating physical events. Partial first checkout or last check-in remains partial; no endpoints or calendar-day assignments are invented. Dates and zones are validated, but a client day/zone is not routing authority. The existing canonical resolver must independently admit and bind the target.

Preparation and execution must both require the original exact-organization and persisted canonical posture under correct rollout-lock ordering before business locks. Legacy OFF SQL behavior, daily V1 parsing/duplicates/responses, identity, tenant authorization, ownership, immutable fingerprints, restart/replay and rollback gates remain. Raw evidence representation and plan reuse are being reviewed; approval does not prove this new path implemented.

Delivery gates: closed input invalid-kind/shape/order controls; old V1 source/behavior preservation; real two full fold chains (165 and 195 minutes, four actual events); gap/shared-boundary review outcomes; OFF/no allowlist/wildcard/persisted mismatch; foreign organization and inactive actor; real lock contention; frozen-input mutation/restart/idempotency; exact rollback/cleanup; affected quality and independent review; final Draft CI. No green parser test can substitute for these public runtime gates.

## Explicit durable command binding

The new format carries a closed `__punchDetailInput` extension of the six-key job envelope. The original envelope, Raw V1 and Plan V1 parsers remain unchanged. The dispatcher validates the extension explicitly; presence with an invalid value never falls back to daily import. Recovery reads this command only from the digest-covered frozen plan; the original repository still never selects job payload or mutable rules/request state.

The domain-separated request fingerprint binds organization, actor/posture/token subject, the exact ordered accepted input, idempotency key and existing engine/strategy options; it excludes new server batch IDs and freeze timestamps. The digest-covered batch mapping snapshot is exactly `{kind:"punch_events_v1",envelope,requestFingerprint}`. Batch metadata repeats the fingerprint only for committed replay comparison; metadata never selects executor behavior. Source family is direct_rows/manual, with one actual event per ordinal, one target and no group side effects.

Both reservation/commit and recovery must compare every raw evidence item and ordinal to the declared command, target identity and source-batch binding. Removing the envelope while retaining marked event evidence is a mismatch. The named format requires canonical shadow/authoritative and strict_targeted admission; it must never silently take legacy or operational-limit branches. Existing authorization, class-00/10/11, rollout recheck, frozen policy congruence and rollback remain additional independent gates. This binding layer alone does not complete public preparation, projection/review execution or native proof.

The original repository no-payload assertion is retained unchanged. A first implementation attempted to select payload and was rejected by that assertion (54 affected unit passes, one matching failure). The SQL change and synthetic-job field were removed; no old test was weakened.

### Command-binding focused verification (2026-10-28)

The command descriptor is checked symmetrically at admission and committed replay. A reserved plan descriptor with a daily envelope/raw input is rejected before acquiring a connection. A daily request cannot reuse a committed punch-detail command under the same org/idempotency key; exact punch retries retain their stable actor/input fingerprint independently of a new server batch UUID. Stored metadata is used only to reject incongruent replay, never to choose execution semantics.

The initial independent source review found two P2 gaps. Main reproduced all five matching failures (three descriptor admission cases, two daily-to-punch replay cases) with six passing controls. After the minimal two-runtime-file correction, eleven affected cases passed with thirty-two filtered. Eight separately removed guards each produced one matching failure and one positive control; exact source restoration passed the ten selected cases with thirty-three filtered. These phases are not a fresh whole forty-three-case run. The earlier thirty-three command cases and fifty-four affected legacy cases retain their source/phase boundaries; the original no-payload regression was fixed by restoring its two source files exactly and rerunning only the one affected case. Same-path explicit lint introduced zero diagnostics and backend type checking exited zero.

Replay tests use synthetic query responses through the real host functions; they are not live PostgreSQL or public HTTP proof. The public punch-detail producer, genuine all-event frozen projection, review-placeholder/no-projection execution, and full D03 native chain remain open. The existing daily V1 parser, raw evidence format, task repository no-payload rule, permissions, locks, transactions and default-OFF boundaries remain unchanged. This unpublished candidate does not delay or form part of the independent R77 organization package.

## Public-path completion boundary and current execution evidence

The approved extension must cover synchronous preview, synchronous commit, asynchronous preview, and asynchronous commit. The original daily-format dispatch, disabled async response and default-OFF posture remain unchanged. A successful synchronous case does not close the async paths.

The synchronous named path now retains all physical events through real PostgreSQL/HTTP fold-start and fold-end cases (165 and 195 minutes). Committed replay separately checks current posture, actor and subject liveness/membership, compatibility/class-10 locks and immutable request fingerprint. It returns the existing result without token consumption or schedule refreezing. A selected real PostgreSQL/HTTP replay case passed with four events, two membership refusals, two posture refusals and unchanged business snapshots; its auth-bypass fixture does not prove real login/RBAC. The original native test call bodies remain byte-identical. The replay-host unit evidence spans phases, not a fresh whole-file run; filtered cases never count as passed.

Durable commit execution must recheck the named imported subject after verifying stored plan digests and job identity, before registry claims and effects. Its existing actor permission check and original plan preconditions remain. A platform-admin actor exemption cannot waive its own imported-subject membership. Expected liveness denial uses the existing terminal precondition rejection; database errors propagate to the transaction runner. The added assembled-callback tests cover ten cases, with six affected existing processor cases passing. Three removed-guard counterfactuals fail with positive controls, and exact restoration passes. This is unit boundary evidence, not native async queue/restart acceptance.

Async commit must use the existing durable reservation and jobId-only processor. Congruent existing jobs must be checked against current admission and the exact accepted command before token consumption/refreezing; no direct effect writer or mutable payload authority is introduced. Async preview needs its own closed, versioned, digest-bound frozen preview record, bound to organization/creator/job/batch. Preview recovery must not refreeze mutable policy or treat preview data as commit authority. Public routing, persisted restart/replay, current membership/posture, contention, rollback/cleanup and actual final CI remain delivery gates for both async paths.

The shared legacy token consumer has a separate exact-source synthetic concurrency finding: two isolated caches can both accept one persisted token while the second DELETE affects zero rows. Its current and base function bytes match. This is not evidence of deployed duplicate business effects, and the punch-detail replay change does not fix it. An independent minimal correction and native concurrency proof remain required; token-enforcement-OFF compatibility cannot be silently changed.

### Async commit candidate boundary

Named async commit retains the original disabled-route response and full-import gate. Before a retry consumes a token or reads mutable scheduling facts, core rechecks current admission and verifies the persisted job/plan identity, complete plan digests and named command. Completed summaries are parsed and digest-checked. Projection never selects the mutable job payload. Fresh requests reuse the existing reservation and enqueue only a job ID; they do not introduce another effect writer. These candidate changes require focused positive/negative and native async validation before any completion claim. Async preview and OpenAPI remain separate mandatory delivery gates.


### Async commit bounded native checkpoint

One new real PostgreSQL/HTTP async commit case passes with four exact import-item event snapshots and a completed durable job retaining the literal 165-minute, two-segment fold-start calculation. Completed replay rejects changed input (409), an inactive imported subject (exact 403), and revoked current full-import namespace access (exact 403); legal retries return the same job. The first retry traces actual native queries with positive role/plan read controls and no token/shift refreeze reads. Original job/plan/terminal and calculation snapshots remain equal. This does not prove absence of every possible extra business row, all plan-chunk immutability on retry, restart, real JWT/RBAC, or async preview. The fixture explicitly uses the existing auth bypass.

Two retained native failures were test-fixture defects: missing namespace/role admission, then the wrong source-label oracle (`import` instead of the established `legacy_import`). The nonexistent `raw_row` test selector was corrected to the actual `preview_snapshot` schema before it executed. Original tests and the 120000-ms budget remain exact. No permission gate or production source marker was weakened. A separate matching unit failure proves the new producer mapped a known durable authorization refusal to generic 500; only that code now maps to the existing public 403, while SQLSTATE 40001 remains generic 500.

Actual unit evidence covers 22 job-replay cases and 16 async-producer cases across phases, plus 20 affected synchronous replay cases; not fresh whole-file 22/16 reruns. Four guard removals each produce one matching failure and one positive control, with exact restoration followed by 4 host and 2 producer passes. Ten same-path lint comparisons introduce zero diagnostics; existing diagnostics remain, and backend type checking exits zero. Independent bounded source review has no new confirmed P1/P2. Current-head CI, final validate:all, full async/restart/contention/rollback/no-extra-effect gates, async preview and OpenAPI remain open. Evidence: punch-detail-async-commit-main-independent-final-audit.json. Draft only; no publication/merge/deployment/flags/config/provider writes.


## Async punch-detail preview: frozen-record implementation contract

This implements the already approved four-public-path scope; it is not a new
permission or an exemption from current actor/subject admission. A preview is
not a commit plan. The old daily preview path remains unchanged.

The new preview record has an explicit `punch_events_preview_v1` kind and closed
version-1 keys. It binds job ID, batch ID, organization, creator/actor posture,
token subject, the full physical-event command, preview limit, server-frozen
attribution/reconstruction, context, and policy-source proof. A separate request
fingerprint excludes fresh server job/batch IDs and freeze timestamps, includes
the preview limit and full accepted command, and is domain-separated from the
commit fingerprint. Idempotency keys are not truncated or silently normalized.

The persisted digest covers the entire record, including the projected preview.
On read/recovery, core compares trusted job-row identity and digest columns,
revalidates the closed frozen input with the existing pure calculator, and
requires the stored preview to equal that deterministic projection. No mutable
schedule/shift/settings/profile query or clock input is accepted by this codec.
The trusted job columns must be frozen by the storage boundary; recomputing a
hash over arbitrary caller-supplied state is not authority. The codec does not
provide permission, transaction, queue, restart, or database-effect evidence.

Subsequent storage/host wiring must keep preview jobs separate from V1 commit
execution. Submission/retry and result reads must recheck current permissions,
actor/subject membership and rollout posture; scoped preview access must not be
silently narrowed to full-import only. Recovery may use only the frozen preview
record and the current authorization checks. Admission and result persistence
must be atomic with their job binding. A preview record cannot be accepted by
the commit enqueue parser. Native recovery/contention/rollback and all four
OpenAPI paths remain mandatory before the slice can be called complete.


### Durable preview storage boundary

Preview jobs use separate `punch_preview_version`, request-fingerprint and
snapshot-digest columns; their existing W4 commit version stays NULL. Version 1
is the only admitted preview version. A separate immutable record stores the
closed codec JSON; organization, creator, batch, fingerprint and digest must
match the job in the same committed transaction. Deferred validation permits
atomic insertion in either order but refuses missing, orphaned or mismatched
records. Ordinary daily jobs remain unchanged, and cannot be converted into
preview jobs by an UPDATE. Preview records and job identity cannot be rewritten,
deleted or truncated; terminal status/progress/timing cannot be reopened.

The database checks identity and structure, not JavaScript canonical hashing or
calculation semantics. The existing codec must still verify the independent job
digest and full frozen calculation before a result is returned. Preview JSON is
never commit authority. Down migration refuses retained preview history and
only removes the empty new storage; it never drops retained jobs or reclassifies
them as daily imports. Runtime submission, worker/restart, permission checks and
public result wiring remain required subsequent gates.

Guarded down requires an enclosing READ COMMITTED transaction and obtains both
table locks before its retained-history query. Stronger snapshot isolation is
refused before DDL: a repeatable-read transaction can otherwise overlook another
transaction's already committed history even after obtaining the table lock.
The candidate pre-fix behavior was reproduced in an owned scratch database;
this is not evidence of a deployed incident.


### Preview reservation and current admission

The preview job independently freezes actor posture and nullable token subject,
in addition to organization/creator/batch/fingerprint/digest. Deferred storage
validation compares those columns to the frozen record; recovery must not derive
its expected creator identity from the snapshot it is verifying.

The core-private reservation host reuses the current timezone/rollout/liveness
transaction and requires a server-owned current target authorizer inside that
same transaction. This callback must preserve the existing scoped preview policy;
it is not a cached full-import permission or a new permission model. Reservation
uses a domain-separated full-key hash under the existing organization/key lock.
Any collision with a legacy job fails closed. Ordinary commit callers retain
their original lock key. Exact retries verify the stored record before returning,
without token consumption or mutable target refreezing. New jobs and frozen
records are inserted atomically; no business writer or queue worker runs here.
The callback connection facade closes on success and failure. Public route,
real policy callback, worker/read/restart and native concurrency remain mandatory.


### Public async preview and job-ID recovery wiring

Named async preview dispatch is after the unchanged existing disabled response
and within the existing import-permission wrapper. It does not grant a new route
permission to scoped-only callers. The current target callback uses the original
full-import and scheduler-scope predicates on the owned transaction. Namespace
admission is inspected fail-closed independently of that target predicate; an
unavailable admission table never grants the new path.

Creation stores only the already specified immutable preview record and a benign
job payload, then enqueues the job ID. Recovery and result reads first load fixed
job identity plus the target command needed for authorization, with no calculated
result and no row lock before timezone/rollout admission. They recheck current
actor/subject liveness, namespace and target permissions before loading and
verifying the complete result. The expected frozen creator identity always comes
from job columns; a permitted same-organization reader need not be that creator.
A changed seed/locked identity or command fails closed. The worker updates only
job completion metadata in the same transaction as verification, never business
records or the immutable snapshot. Queued/running recovery uses frozen facts;
completed/failed jobs are verified without another status write. Current admission
refusal rolls back and propagates for queue handling rather than fabricating a
successful preview or falling through to the old daily importer. Native recovery,
contention, permission changes, rollback and queue-failure behavior still require
execution evidence before completion.

Raw preview jobs cannot be projected through the old mapper. Only the verified
core result supplies its compatibility projection, exposing the original request
key and calculated preview only for completed jobs. Disabled preview dispatch
cannot process new preview jobs. All legacy branches and other named paths retain
their original source behavior; new schema columns are required before this code.

### Four-path OpenAPI parity

The approved named format is documented on synchronous and asynchronous preview
and commit. Each request union excludes any present inputKind from its unchanged
daily branch; the named branch is closed and admits only punch_events_v1. Shared
transport fields do not grant identity or policy authority. Schema bounds cover
one through six physical events; calendar/IANA validity and chronological,
alternating-event checks remain explicit server semantics. No schema default
converts named events to daily rows or grants a scoped-only async route permission.

Synchronous preview and verified async job results expose physical source ordinals,
the retained event count and the actual frozen calculator projection, including
nullable review outcomes and fold/offset metadata. These raw calculator segments
are distinct from persisted calculation-detail DTOs. Commit keeps the existing
result envelope with explicit event/target counts. All four paths document the
existing refusal/error classes. OpenAPI/SDK generation and focused schema/runtime
projection checks do not substitute for native restart, contention or rollback.


### Native preview durability gate (2026-10-28)

The approved async preview must recover persisted job identity in a fresh process, serialize competing completion attempts, and retain atomic reservation/completion rollback. Three new cases use the real PostgreSQL hosts and real admission rows. The frozen calculation context and target-policy callback remain synthetic fixtures; they do not establish real JWT/scoped-policy authorization or Redis queue restart recovery. Existing public HTTP proof remains a separate phase.

- Fresh child process receives only job ID, rechecks current namespace admission before full result access, completes the stored preview, and replays idempotently in another fresh process.
- Competing native connections must show `pg_blocking_pids` contention within the unchanged 3000ms/20ms observation budget, exactly one successful completion update, and one idempotent terminal peer.
- PostgreSQL division-by-zero after preview-record INSERT and completion UPDATE must restore the deleted fixture token, leave no orphan reservation, and preserve queued completion state; exact healthy execution follows. This is transaction rollback proof, not proof of the shared token consumer race.
- All eight relevant business-table snapshots remain unchanged. The immutable preview record stays identical. No previously passed public native case is rerun.

Status: added, execution pending. Full slice recovery/scoped-policy/queue and final review gates remain open.

Execution update (supersedes the pending status above): three distinct native host lifecycle cases and one mock acquisition-failure helper case passed across two phases, not a fresh whole-four run. The first native phase had three passing cases and one child-load failure; only the failed recovery case ran again after diagnosis. Its fresh Node child now executes a bundle built from the current 54 local source inputs using the already-installed tsx compiler dependency; the bundle and source hashes were independently verified. All 120000ms native, 15000ms child, and 3000ms/20ms contention budgets remain unchanged. No production runtime was changed. Original test bytes and four default fixture variants were independently preserved; explicit lint introduced zero diagnostics. The bounded independent review's two test-helper P2 findings were fixed; no remaining confirmed P1/P2 in that review. Native scoped policy/real JWT, Redis/queue recovery, full fold families, shared-token PSP02, final full-slice review and Draft/current-head CI remain open.


### PSP02 durable commit-token single consumer

The existing enforced token consumer must admit only the native deletion winner, including cold, warm and mixed independent process-local caches. A cache cannot revive missing or expired persisted authority. Organization/requester/expiry remain mandatory predicates; missing storage fails closed and non-schema SQL failures propagate. The existing enforcement-OFF path, token issuance, literal flag behavior, route ordering, current admission and idempotent replay stay unchanged. No schema, permission, enabled flag or business-effect writer is added.

Native proof will hold the token row in a separate connection, observe both contenders blocked within 3000ms/20ms, then require one true and one false. Wrong organization/requester must preserve a valid token; missing/expired authority and storage failures refuse. Existing public token-ordering case is an affected neighbor, not a claim of real RBAC. All older passing native durability suites remain untouched.


PSP02 local execution update: the original exact consumer admitted both contenders in all three native cold/cached/mixed-cache cases. The candidate now uses one scoped, expiry-qualified DELETE RETURNING as the required-mode authority; the original OFF path, issuance and route bodies are byte-identical. Independent review found a real transactional schema-error masking issue in the candidate's preliminary prune; removing that new pre-prune preserves the original SQL error without claiming transaction ownership. Caller rollback restores provisional token consumption. Current positives total eleven distinct cases across phases (nine new native private-consumer cases, one no-database compatibility control, and one existing real-HTTP neighbor), not a fresh whole-eleven run. Four current guard counterfactuals each gave one matching failure plus one OFF control; exact restoration gave three selected passes. The earlier unused-parameter mutation failure is retained but is not matching evidence. Explicit lint introduced no diagnostics (the existing index diagnostics remain); validateall passed. The bounded independent source review has no remaining confirmed P1/P2. Real JWT, full queue recovery, the rest of the approved punch-detail slice, publication and exact-head CI remain open; this is local Draft-candidate evidence only.


### Real password login and current preview authorization

Two new native HTTP/PostgreSQL cases passed in one selected run (42 prior cases filtered, not passed). Actor requests use actual password login, a persisted session sid and current database permissions with RBAC_BYPASS and token trust disabled; the existing setup-only day fixture still uses its original bypass. Scoped-only sync preview succeeds without a global import grant, while the original async full-import wrapper still refuses that actor. Full-import async preview completes through the durable worker; later reads reject a foreign organization, revoked import permission, revoked namespace admission, inactive target membership and revoked session with the same original JWT. Seven named organization business-table snapshots and the complete job/record remain equal across those reads. These are bounded end-of-sequence snapshots, not exhaustive per-request database auditing.

Three separate counterfactuals each caused the named denial assertion to observe actual200: namespace predicate removal, membership active predicate removal, and verifyToken sid rejection removal (refresh remains unchanged). Every source was restored exactly; the affected FULL case then passed once (43 filtered), not another unique case. Explicit helper lint passed and registration baseline lint introduced zero diagnostics; prior production quality applies by unchanged source, without a new validateall run. Independent bounded source review found no confirmed new P1/P2. No production source changed in this test-only supplement.

This does not prove current actor deactivation, all authentication variants, scoped-only durable-worker recovery, changes before worker execution, Redis transport, queue failure/restart, all fold families, final publication/CI or R77 target compatibility. Those gates remain separate.


### Native queue-add failure and fresh server startup gate

The preview route must retain its durable queued identity when queue.add rejects, and an exact retry must preserve the same immutable result without consuming the token again. A fresh process must boot the actual MetaSheetServer and attendance plugin, discover that job through the existing startup query, and deliver only its stored job ID through the registered processor. The controlled queue transport holds offers; it is not Redis proof. The real current policy must refuse revoked full-import without scope, wrong scoped target, disabled namespace and inactive target before completion, then allow the exact scoped target without a global import grant. Each refusal must preserve the complete job/record and seven named business-table snapshots. Terminal replay must be byte-identical. Production authorization, queue code and all existing test bodies remain unchanged. Async commit queue recovery and real Redis deployment remain separate open gates.

Status: test-only candidate added; native execution and independent review pending.


Queue startup execution update: one new native real-HTTP/PG/fresh-MetaSheetServer case passed (44 filtered, not passed). A controlled queue.add rejection leaves exactly one queued preview and immutable record; exact HTTP retry retains the same job and token state without enqueueing again. A fresh process discovers the durable ID through the real startup query, then the registered processor rechecks current import/scope, namespace and subject membership. Scoped-only recovery succeeds for the precise target without a global import grant. Complete job/record and seven named business snapshots are checked after each refusal; immutable record and business snapshots remain unchanged after completion and terminal replay.

Two counterfactuals produced matching failures: weakened target scope reaches the named wrong-target assertion, and omitted startup enqueue reaches the named missing-target assertion after an unchanged real query observes the job-scan loop completion. Exact restoration passes the same selected case, not an additional unique case. The current-source child bundle has 841 audited local inputs; no old dist, dependency change or budget increase. The initial token-OFF oracle failure, unbundled child-stop timeout and first omission counterfactual that reached the outer 120000ms limit remain retained failures; their results are not native successes or production defect proof. Independent review's two test-only findings were corrected (unconditional parent restoration and terminal-replay business snapshot); final bounded source review has no confirmed P1/P2.

This is controlled queue transport in test mode, not Redis/live deployment. Commit queue failure/recovery, remaining fold families, full-slice publication/CI and owner/manual/live acceptance remain open. No production source was changed by this supplement.


### Async commit queue failure and actual startup recovery gate
The named punch format must retain its durable V1 plan/chunks after queue-add failure and reuse the same reservation/token state on exact retry. A fresh actual server must discover the durable job ID through startup recovery and run the registered canonical worker. Current full-import permission, namespace admission and target organization membership are rechecked: each rejection remains terminal, preserves immutable plan/chunks and produces no change to seven named business tables. A distinct healthy reservation must produce the literal four-event/two-segment/165-minute fold-start result and no extra effects on terminal replay. These are controlled-queue native tests, not Redis/live acceptance. Existing 120000ms case, message and cleanup budgets remain unchanged. Execution pending; no partial PR publication.


Async commit queue execution update: four distinct new native cases passed across phases (permission, namespace and healthy in one phase; only the corrected subject case in the next). This is not a fresh whole-four run. Each uses actual HTTP password/session admission, controlled queue.add failure, a durable V1 plan/chunks, exact same-job retry without another enqueue, and a fresh MetaSheetServer that discovers and delivers only the startup-offered job ID. Permission/namespace refusal uses the original authorization reason; named-target membership refusal uses the existing terminal precondition-changed reason. Failed reservations do not revive after admission is restored, and seven named business-table snapshots remain unchanged. The separate healthy reservation produces exactly four physical import-item ordinals, two literal fold-start segments and 165 minutes; calculation/batch/item counts increase by one/one/four, and terminal plugin redelivery preserves the complete stored state and those seven snapshots.

Removing the actual worker full-import authorization callback produces one matching named permission failure; exact source restoration passes that selected case. The original chunks-query schema error (four failures) and incorrect subject enum (three passes/one failure) are retained test-fixture history, not production defect claims. Independent bounded review's one P2 is fixed and independently audited. New child bundles are checked against 841 source inputs, including the explicitly retained negative variant. No production implementation, old test body, timeout, schema, dependency or flag changed in this supplement. The final enum-only delta is tied to the preceding explicit zero-diagnostic helper lint by exact inverse source comparison.

Boundaries: controlled queue is not real Redis/live acceptance; worker consumes durable actor identity, not a JWT/session on each execution; snapshots cover seven named organization-scoped business tables, not all SQL or every database table. Completed plugin redelivery takes its existing terminal fast path, not a new proof of the core completed-response replay branch. Token absence/retry here is not a separate required-token concurrency proof. Full fold caller families, final complete-slice review/Draft/current-head CI and owner/manual/live gates remain open. This attendance supplement is independent of the R77 organization kit.


Public review-family gate: add two new native HTTP cases for the fixed internal-gap and shared-fold boundaries. Each exercises synchronous and asynchronous preview/commit with the original four physical events, preserving the exact typed review reason, null daily projection, hidden review placeholder and no active calculation pointer/segments. Ordinary frozen-prior recompute must reject the retired placeholder and preserve eight named business-table snapshots. Existing kernel and fold-chain passing evidence is retained; this new route evidence is pending execution. The fixture uses the existing auth-bypass seed, not a fresh login/Redis acceptance claim. No original case body or 120000ms budget changes.


### Public review-family execution and fixture lifetime closeout

The two new public review-family cases pass against real HTTP/PostgreSQL: fixed gap and shared-fold each retain all four physical events through synchronous preview/commit and asynchronous preview/commit. Both preserve their literal typed review reason, null daily projection, hidden retired review placeholder, null active pointer and zero segments. Ordinary frozen-prior recompute rejects the original retired parent with the exact existing 409 code; eight named organization business-table snapshots remain unchanged. These are two cases across four paths each, not eight distinct tests.

The original omitted nullable-version request fields caused two retained 400-versus-409 fixture failures. Explicit null fields corrected that request without changing the 409 assertion. The subsequent four-case phase passed both public review families and both complete fold chains (165/195 minutes through L0/I0/R0/O1/R1). The fold recheck was justified by the later I0 replay-admission change; those two passed chains were not repeated after the test-only cleanup correction.

Independent review found one test-fixture lifetime P2. New fixture IDs are now allocated before seeding and cleanup removes only their direct grants, role links, namespace admissions and sessions, deactivating their user/membership rows while leaving referenced business history in place. Both public families and a new late-seed-failure control pass in one three-case phase. The failure control throws after real seed completion and before callback entry; it does not enumerate every internal seed await. Five exact cleanup authority-count checks pass in that phase. Historical unjournaled synthetic fixture residue is retained, not guessed and deleted. Business-history retention is established by bounded cleanup source, not an additional post-cleanup snapshot or real-auth cache-revocation proof.

Temporarily replacing the public preview reason with the wrong literal produces one matching named assertion failure. Exact source restoration then passes the selected case; this counterfactual is not a claim of a natural production defect. Explicit new-helper lint has zero diagnostics; same-path registration baseline/current each retain three prior diagnostics with none introduced. Production/config/dependency/workflow inputs remain byte-identical to the prior successful validate:all phase, so that green suite was not repeated. The bounded cleanup reviewer reports no remaining confirmed P1/P2.

Evidence: review-public-main-independent-final-audit.json, review-public-production-quality-applicability.json, review-public-cleanup-source-preservation.json. Wrapper token enforcement is OFF for these selected chains; required-token concurrency proof remains separate. Existing auth-bypass fixture posture is disclosed; real JWT/session and controlled-queue startup proofs remain separately scoped. No real Redis/provider/live acceptance, ordinary-reader HTTP list proof, all-table/no-SQL claim, current-head CI or whole-product completion is inferred. Complete-slice delivery audit, Draft publication/current-head CI and independent owner/manual/live gates remain open.
