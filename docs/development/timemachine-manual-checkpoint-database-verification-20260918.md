# Manual Archive Checkpoint Database Verification

Status: LOCAL CANDIDATE; no runtime caller, enablement or deployment.

Parent: `b843d37cc21e665f7f0686a4d21b0cc14fc64105`.
Main inspected: `89f1ecdee2c3b70205a318074824c834bc6a5c7e`.
Existing carrier: Draft/HOLD #5849. Its earlier remote CI is not evidence for
this database extension until this candidate is published and checked.

## Bounded Change

- New forward migration only. Previously deployed migrations are unchanged.
- Preserve bootstrap genesis and its immutable marker. Repeated captures use
  nine fresh `section_checkpoint` operations, `checkpoint_snapshot` revision
  actions, and the existing `archive_snapshot` parent kind.
- Reuse generation reservations, owner/fence and source-vector binding. Do not
  introduce a second marker ledger or admit ordinary events as full snapshots.
- Require exact row-count/hash payloads, uniform member kinds, a sealed earlier
  genesis, and parent/member reservation identity binding.
- Dedicated internal checkpoint helper uses v2 identity hashing and private
  allocation proofs. It rejects unavailable/expired ownership, incomplete
  reservations, partial seals and changed-content retries.
- Migration replay checks canonical old/new function bodies, trigger wiring and
  CHECK definitions. PostgreSQL canonicalizes expected CHECK expressions rather
  than lowercasing quoted literals. Empty rollback restores old definitions;
  rollback with any checkpoint authority rows is refused.

The migration carries explicit original and replacement function definitions
so rollback does not synthesize or rewrite a live function body. Most of its
size is the unchanged bootstrap, restore and claim-anchor authority branches.

## Local Evidence

Commands, from the isolated worktree:

```sh
TM_TEST_PG_BIN="$(pg_config --bindir)" node scripts/ops/run-recovery-manual-checkpoint.mjs
NODE_ENV=test pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-manual-source.mts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-archive-section-checkpoint.test.ts tests/unit/multitable-recovery-archive-source-vector.test.ts tests/unit/multitable-recovery-archive-seals.test.ts tests/unit/multitable-recovery-archive-section-bootstrap.test.ts
pnpm --filter @metasheet/core-backend exec tsc -p scripts/tsconfig.recovery-archive-acceptance.json --noEmit
pnpm --filter @metasheet/core-backend exec eslint src/multitable/recovery-archive-section-checkpoint.ts src/db/migrations/zzzz20260918120000_add_recovery_archive_section_checkpoints.ts
```

Checkpoint acceptance used a task-owned PostgreSQL 15 cluster and unique
synthetic database. Before implementation, full fresh migration and bootstrap
passed; the first checkpoint reservation failed with SQLSTATE 23514 and
`recovery_archive_snapshot_reservation_shape_invalid`.

After implementation:

- Full fresh stream and second migrator no-op replay pass.
- Direct migration `up/down/down/up/up` passes independently of the ledger.
- Same-name CHECK(true), a RETURN NEW guard body, and a disabled guard trigger
  each cause direct replay to refuse schema drift. All mutations roll back.
- Independent migration review identified missing drift verification of the
  pre-existing bootstrap-marker authority. The follow-up pins both original
  marker function bodies and row/truncate trigger wiring without replacing
  them. Marker RETURN NEW and disabled-row-trigger mutations now fail replay;
  the full acceptance driver passes after restoration.
- Bootstrap succeeds; two subsequent checkpoint generations succeed. Repeated
  identical finalization is read-only and exact; different content is refused.
- Missing genesis, ordinary seal forgery, unexpected payload keys and a section
  revision without its reservation are refused by their specific DB guards.
- Original bootstrap marker remains byte-equivalent. Exactly 18 checkpoint
  operations remain after two accepted generations; rejected transactions leave
  none behind.
- Populated migration down refuses with `RECOVERY_ARCHIVE_CHECKPOINT_DOWN_IN_USE`.
- Four focused/neighbor unit files: 60/60 pass. Acceptance typecheck passes;
  source/migration ESLint has no errors or warnings.
- The neighboring full-source driver also passes on the new full migration
  stream: seven sections, attachment inventory, scope/liveness negatives and
  two-client source-snapshot visibility.

Discriminating DB mutation: temporarily remove the dedicated seal-kind guard
inside a transaction. A reserved full-section event can then be sealed as
`ordinary`, proving the guard is load-bearing. Rollback restores the complete
canonical function definition, verified by exact comparison.

The acceptance driver closes clients/pools, drops its database, and asserts
database/connection residue zero. Cluster shutdown is a separate final cleanup
step, not inferred from a passing test. Final independent database/backend
prefix counts were both zero; the owned PG15 cluster was stopped and its data
directory removed after checking PG_VERSION and absence of a postmaster PID.

## Review And Remaining Gates

Terra implemented the dedicated helper; coordinator corrected the parent-kind
interface before integration and added expiry checks. Luna's read-only helper
review found no concrete P1/P2. This verdict does not cover the migration.
The first Sol migration attempt timed out without an artifact or verdict and
was closed; coordinator implemented the forward migration directly.
Terra migration review found the bootstrap-marker dependency drift gap above.
After its fix and successful full DB rerun, the narrow closure review found no
new P1/P2. All reviewer sessions are closed. This is not a whole-product final
review or remote CI result.

Remaining: remote exact-head proof of the new required-CI acceptance step;
lease takeover and permission-revocation tests;
bounded canonical capture coordinator; permission/provider revalidation;
authenticated object receipts; publication and restore-loop acceptance; UI.
Identity and DB sealing alone do not prove captured bytes correspond to the
current source state. No manual-capture endpoint or button is claimed here.

## CI Compatibility Follow-Up

Remote head `20c0a121eef30df1c41b439c2883a64a3ae8435b` failed the migration
replay job and two historical real-DB suites in Node20. The new checkpoint
amendment was missing from the causal replay roster; historical suites also
reset older function definitions without first unwinding the newer amendment.
Fresh migration succeeded; the full catalog fingerprint correctly detected
the mismatch. No production migration or fingerprint assertion was weakened.

The test-only correction appends the transaction-wrapped checkpoint migration
to replay, and temporarily unwinds/restores it around historical suite setup
and cleanup. The wiring census now requires all 28 migrations. The checkpoint
acceptance driver runs the actual replay verifier and both historical suites
before its own protocol assertions.

Local restored verification: replay 28 migrations / 931 catalog objects with
identical fingerprint; section causality 40/40; claim anchor 19/19; checkpoint
acceptance passed; wiring contract 36/36; acceptance TypeScript passed.
Removing the new replay entry reproduced `catalog_changed count=12`; restoring
it returned the full driver to green. The wiring contract independently rejects
the same removal. Luna's narrow static review found no concrete P1/P2; it ran
no tests and is not a whole-product verdict. Remote CI on the follow-up commit
must be checked separately; local success does not supersede the failed 20c run.

## Concurrent Retry And Expiry Follow-Up

The acceptance driver now uses two real PostgreSQL clients for the same
persisted checkpoint plan. The first consumes all nine members inside an open
transaction. The second is observed through `pg_stat_activity` and
`pg_blocking_pids`: it must wait on the generation `SELECT ... FOR UPDATE`,
not merely block later on a duplicate INSERT. After the first commits, the
second returns the exact same plan; exactly nine revision rows exist.

Mutation: remove `FOR UPDATE` only from the second client's generation query.
The new barrier fails because the observed blocking query is an INSERT into
section revisions. Restore the query and the complete driver passes again.
Production helper and migration bytes are unchanged by this test-only slice.

Three further negatives prove lease expiration, archive expiration, and a
mismatched owner fence return `RECOVERY_ARCHIVE_CHECKPOINT_GENERATION_UNAVAILABLE`
with zero checkpoint revisions. Short synthetic lifetimes are assigned at
INSERT and allowed to elapse; no ownership trigger is disabled. An initial
attempt to shorten an existing active lease was rejected by the existing
catalog guard and was replaced with this legitimate expiry fixture.

These tests do not prove actual owner takeover, user permission revocation,
source coherence under concurrent edits, process restart, or runtime capture.
The concurrent driver passed locally; its new required-CI wiring below still
needs an exact-head remote run before it counts as remote evidence.

## Portable Required-CI Runner

`scripts/ops/run-recovery-manual-checkpoint.mjs` creates an isolated cluster in
the platform temporary directory, with a unique port and fixed synthetic DB
owner. It accepts only the PostgreSQL binaries directory, not an existing DB
URL/data directory. The driver validates loopback, nonstandard port, role,
temporary path ownership, and the server's actual data directory before
creating its unique database. It continues to sanitize migration environments.
The runner stops the owned cluster and removes its directory after success or
failure; ambiguous server status refuses removal.

`plugin-tests.yml` invokes this runner after PostgreSQL setup, in both matrix
versions, without conditional skipping or continue-on-error. Existing workflow
content is byte-equivalent after removing the one added step. The static wiring
contract is 37/37 and rejects removal/conditional disabling of this invocation.
Only `evidenceFiles.pluginTestsWorkflow` changed in the official provenance
recomputation. Old pin failed; refreshed pin passed with differenceCount=0.

Local PostgreSQL 15 portable run passed the full driver and automatic cleanup;
acceptance TypeScript passed. The first portable startup exposed macOS temp-path
symlink canonicalization and missing LC_ALL; both are corrected. Its stopped
failed-start cluster was removed separately after checking PG_VERSION/no PID.
Sealed-export S5 was rerun with the already-installed mssql package supplied via
temporary NODE_PATH because this worktree lacks that package's direct symlink;
no dependency installation or package changes were made.

Coordinator refute-first found no blocking issue in this bounded test-runner
delta. A Luna read-only review did not return a terminal verdict within its
bounded window and was closed; no external approval is claimed for this slice.

The independent source-reader driver still uses its older local-only launch
contract. This slice wires checkpoint acceptance, not that separate driver or
the unfinished runtime manual-capture coordinator.

No automatic scheduling, retention policy, cleanup, customer storage, flags,
dispatch, staging, deployment, production, or hard-deleted-table resurrection.

## Remote Proof And Interrupted-Upload Regression

Published head `9072e1192b6f8d825413cf0815e7db255b22bef5` completed with
34 successful checks and one expected skip. Plugin run `35285210558`, Node18
job `105415896318` and Node20 job `105415896343`, each logs the new isolated
checkpoint step: 28 migrations / 931 catalog objects with equal fingerprint,
59 historical tests, checkpoint/concurrent retry/expiry acceptance, and zero
database/connection residue followed by owned-cluster stop/removal.
This closes the remote wiring gate for that head, not the manual runtime flow.

A subsequent unit regression models one uploaded ciphertext followed by an
interruption and another invocation using changed source bytes. The same nonce
registry state refuses the retry before any new sealing/upload; the previously
uploaded ciphertext remains unchanged. This is an in-memory registry model,
not a process-restart or durable-storage acceptance. Crypto 58/58 and snapshot
planner 11/11 passed. Temporarily swallowing the production nonce reservation
error makes the new test fail; restoration returns 69/69, with zero production
diff. The interrupted-capture coordinator/original-byte persistence remains OPEN.

## Prepared Byte Store Local Acceptance

Additive migration `zzzz20260918130000` and internal
`recovery-archive-prepared-capture.ts` implement immutable generation-owned byte
persistence. This is a local successor to `1a45a0798b11a2c173655fe5c22fd8c638da1d38`,
not part of the remote 9072 proof above. The existing required owned-cluster
driver now exercises the byte store; no workflow or provenance pin was changed.

Fresh/replay and causal down/up now cover 29 migrations and 946 catalog objects,
fingerprint `f97da837b6a6c10583aeb22c84f64aa40573cc32a5b52ad5eaf6cedb2e22d76e`.
The claim-anchor fixture explicitly includes the new FK child in owned-state
cleanup; no CASCADE or assertion weakening was used. Both historical suites
remain 59/59. The static migration census includes the new entry and a removal
negative, with wiring 37/37.

Synthetic AES-GCM bytes commit once, then a separate PostgreSQL connection reads
the identical payload. Same-byte retry succeeds; changed bytes conflict. Reads
without an explicit transaction, mismatched fence, expired lease and expired
generation refuse. UPDATE/DELETE/TRUNCATE and nonempty down refuse. Direct empty
up/down/down/up/up succeeds. NOT NULL, CHECK(true), disabled-trigger and replaced
guard-function mutations make replay fail and roll back to canonical state.

Discriminating production mutation: removing the stored-byte equality check makes
the changed-payload test fail with a missing expected conflict; the driver exits
nonzero while still dropping the owned database and stopping/removing its cluster.
The guard was restored before final acceptance. TypeScript acceptance compilation
and scoped source ESLint pass. No external review verdict is claimed.

This proves cross-connection durable byte storage, not an end-to-end process
restart, real wrapped-key envelope, object-store resume, permission recheck,
request binding or archive publication. Those coordinator obligations remain OPEN.
Only a disposable synthetic database was used; no customer storage or flags.

## Prepared Envelope Continuation

Successor to local `88a8add2786ab0f465b08562a51e383bba23fa0c` connects existing
reserve-then-seal to immutable persistence before any upload. An existing
envelope bypasses capture, custody and encryption. Closed-envelope negatives
cover extra envelope/binding/plaintext keys, missing/reordered sections, invalid
base64, duplicate nonces, short tags and empty wrapped material. Crypto and
snapshot-planner focused suites pass 71/71. The new tests live in the already
required crypto whole-file suite; no selector change was necessary.

The unit interruption test uses an in-memory query model and the existing
synthetic custody adapter; it is not real custody assurance. It proves upload
starts only after persistence, retry performs no capture/reservation, callback
mutation leaves the retained payload unchanged, mismatched sheet binding refuses,
and injected authority revocation stops subsequent uploads. Forcing the resume
branch to recapture produces `MUST_NOT_RECAPTURE`; restoration returns 71/71.

The owned PostgreSQL driver independently stores a presealed ten-section fixture,
interrupts a synthetic upload callback, closes/replaces the DB connection and
resumes all ten original sections without invoking capture. It preserves the
exact envelope and refuses an injected revoked-authority callback. The fixture's
wrapped handle is synthetic, not a KMS/local-custody proof; no object provider is
contacted. Fresh/replay, 29-migration catalog fingerprint and 59 legacy tests
remain green; database/connections and owned cluster are cleaned.

Actual actor/request binding, source consistency, runtime permission integration,
object PUT/HEAD receipts, catalog publication and the manual UI remain OPEN.

## Legacy Migration Layer CI Repair

Remote `79798b1b4ee2db65125299ba913ed7d3d1155153` is NOT all-green: Node18
passed, but Node20 job `105468004548` in run `35302546154` failed in the broad
multitable real-DB step (six suites). The first concrete failure was PostgreSQL
0A000: the new prepared-capture FK prevented old catalog fixture TRUNCATE.
Follow-on transaction failures were not classified as flakes and no rerun was used.

Six historical migration suites now use a test-only layer helper. It audits and
rolls back empty prepared storage and checkpoint amendments in one transaction,
runs the original suite, then restores and audits both layers before DB closure.
Production down guards remain intact: populated storage cannot be removed.
No foreign key, immutable trigger, production constraint or test assertion was
weakened, and no CASCADE was introduced. Legal-hold migration tests also need
the old checkpoint parent function definition during their exact-schema checks.

Discriminating local progression: unwinding only prepared storage made all 127
historical assertions pass but the following checkpoint audit failed with
SCHEMA_DRIFT. Unwinding/restoring both layers for all six suites closes that
gap. The owned-cluster driver now explicitly runs those six suites (127/127),
the original two suites (59/59), and repeats the full 29-migration replay after
the historical tests. Current checkpoint, prepared-byte and continuation
acceptance follows that replay; the owned database/connections and cluster are
removed on success or failure. This is fixture/migration-order repair, not a new
manual-capture capability or permission expansion.

## Canonical Manual Continuation Authority

Local successor to `2132c1b63662b1aaa6973e430f8906bdad45f5bd` extracts the
existing recovery worker scope evaluator without changing worker job-ID checks.
The internal `createRecoveryArchiveManualContinuation` factory binds that
evaluator to the existing `hasFullTableReadAccess` policy and supplies the
prepared-upload authority callback itself. It registers no HTTP route.

Focused worker/crypto suites pass 73/73 using query-model fixtures, not live
permission/UAT proof. A resumed ten-section upload reads the database actor
eleven times (entry plus each upload); initial and mid-upload deactivation,
scope drift, mismatched crypto scope and lookup errors refuse. A separate
negative proves management authority cannot bypass a denied full-read result.
Neutralizing the manual continuation's denied-authority guard makes the inactive
actor negative fail (promise resolves); restoration returns green. Existing
worker apply/plan/stabilization neighbors retain their previous outcomes.
Acceptance TypeScript compilation, scoped module lint and diff-check pass.

Outstanding: durable request/actor admission, real-DB permission-race acceptance,
source locking/revalidation, provider receipt persistence and catalog publication.
No archive command, flag, deployment, customer data or external storage was used.

### Real Database Continuation Authority Follow-Up

On local `99abfd2de0482f5a10c28a69582e7570ff58bbca` plus this acceptance
addition, the owned-cluster driver invokes the canonical factory with a real
synthetic active admin user. All ten presealed sections upload through a stub.
A separate PostgreSQL connection then deactivates that user immediately after
the first upload: the second section and subsequent retry both refuse with
`RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE`. A mismatched base binding also
refuses before upload. This proves fresh database authority between sections;
it does not prove cancellation of an already in-flight provider operation.

Fresh migration/replay, the 29-migration catalog fingerprint, 59 legacy anchor
tests, 127 historical migration tests, and checkpoint/prepared acceptance all
pass. Owned database/connections are zero and the synthetic cluster is stopped
and removed. The envelope is presealed synthetic input and uploads are callbacks,
not actual KMS/object-storage or process-restart acceptance. Durable request
admission, consistent source capture, provider receipts, catalog publication and
the command/UI remain OPEN. No flags or deployment changed.

## Durable Request Binding Acceptance

Local successor to `7ce6696fd00e3d5d0ac45fac364e127a1c76e352` adds the
manual request migration, internal lookup/bind helper, and owned-cluster tests.
The synthetic driver proves new-connection lookup, exact retry, actor isolation,
scope/generation conflict, explicit transaction enforcement, and a two-connection
retry waiting on the first transaction before returning the same generation with
one persisted row. Row UPDATE/DELETE/TRUNCATE and nonempty migration down refuse.
Column-nullability, disabled-trigger, function-body and deferrable-unique drift
are rejected on replay; empty down/down/up/up succeeds.

Discrimination: temporarily removing the helper's hash comparison lets a tampered
stored hash resolve instead of rejecting. The real-DB assertion fails with
`Missing expected rejection`; restoring the comparison makes the full driver pass.
Both runs remove the owned DB/connections and stop/remove the synthetic cluster.

Full fresh migration and replay pass. The exact Time Machine replay census is now
30 migrations / 963 catalog objects, fingerprint
`47d05a62b2afabf386aacbedc725ff7ed92dfcde7064b580fd17851093d150e4`.
Existing 59 anchor/section tests and 127 historical migration tests pass, followed
by a second complete catalog replay and all checkpoint/prepared/authority tests.
Historical fixture layers explicitly unwind/restore the empty request layer;
production retention guards are not weakened. Static wiring 37/37, acceptance
TypeScript and scoped source ESLint pass. No workflow selector is removed.

This is internal durable identity, not completed request admission: generation
allocation and canonical authority must still be composed in one transaction.
No command/UI, real object provider, customer data, flag or deployment is exercised.

## Atomic Reservation Admission Acceptance

Local successor to `de78798590800f48c1998879aa7f56eaacb4e19b` invokes the
canonical runtime admission factory on the synthetic database. First capture
persists nine bootstrap identities and one snapshot identity; a sheet with genesis
uses nine checkpoint identities. Exact retry returns the original generation.
A second connection waits behind the first admission transaction, then returns
that generation with `replayed=true`; the catalog grows by exactly one row.

Cross-base and revoked-user calls refuse, including revoked replay. A wrong key
row version and a missing active trust checkpoint refuse without generation growth.
Fault injection at the request-binding INSERT rolls back the already-created
generation and reservations, and the request remains absent. Neutralizing the
lookup-first replay return makes the exact-retry positive fail with
`RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT`; restoration passes the complete driver.

The driver retains fresh/replay, the 30-migration catalog census, 59+127 historical
real-DB tests and all earlier checkpoint/prepared/request/authority acceptance.
Unit neighbors pass 73/73; acceptance TypeScript, scoped new-module ESLint and
full sealed-export S5 pass. Tests use only the owned synthetic cluster; cleanup
requires database/connections zero and cluster removal. This evidence proves
reservation admission only, not consistent source sealing, archive publication,
HTTP/UI readiness or use of customer storage.

## In-Fence Source Snapshot Acceptance

Local successor to `2c1ace18f57ed384b49b85cac9333ddc73e98b55` adds source
snapshot handles to fresh admission, while exact replay returns no source handle.
The real-DB driver proves empty and nonempty snapshots, detached-copy mutation
isolation, and unchanged-source recheck. A separate connection adds schema/record
data after the empty capture and later changes an existing record/version: each
old handle refuses with `RECOVERY_ARCHIVE_MANUAL_SOURCE_CHANGED` and retains its
original data. A new request can capture the later state; the old request cannot.
User deactivation, fabricated handles and elapsed generation lease also refuse.

Removing the digest comparison causes the schema/record drift negative to fail
with `Missing expected rejection`; after restoration the complete owned-cluster
driver passes. Existing 30-migration replay, 59+127 real-DB neighbors and all prior
acceptance remain included. Focused source/worker/crypto tests pass 115/115;
acceptance TypeScript, scoped module ESLint, static wiring and S5 are also checked.
Owned database/connections and temporary cluster are removed after either result.

These are in-process source and recheck proofs, not a crash-resumable plaintext
store, verified attachment bytes, sealed source revisions or complete publication.
No HTTP route, flag, customer storage or deployment was introduced.

## Source-Bound Continuation Acceptance

Local successor to `4f68eb0fdb73255a5033daac1b02ee5286c2bd0a` binds the
first encryption attempt to the original admission source. The owned PostgreSQL
driver checks missing handles, different-generation handles, actor/anchor mismatch,
single consumption, and altered relational plaintext refusal before key custody.
The positive path uses real AES-GCM with synthetic custody and nonce-reservation
ports, interrupts the first upload, then resumes all ten authenticated sections
without a source handle, capture call, second DEK or second nonce reservation.
Decrypted relational sections are compared to the original snapshot's canonical
bytes. The other three fixture sections are synthetic, not attachment/permission
or coverage proofs; the upload callback is not an object-store receipt.

Mutation: removing plaintext equality admitted altered records and reached the
synthetic upload interruption instead of `RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH`.
The negative failed precisely; the original guard was restored. Both mutation and
normal runs remove their owned database/connections and temporary PostgreSQL cluster.

After restoration, the full isolated driver passes, including 30-migration replay
and existing 59+127 real-DB neighbors. Focused source/worker/crypto is 115/115;
acceptance TypeScript, scoped source ESLint, static wiring 37/37, full sealed-export
S5 and diff-check pass. Final driver log:
`/private/tmp/tm-manual-source-continuation-final.log` (local evidence only).

The remote predecessor was verified at 35 SUCCESS / 1 intentional SKIPPED. During
this local batch main advanced from `89f1ecdee2c3b70205a318074824c834bc6a5c7e`
to `62aa4dc4cdf99ecad72f3acb2b34430d8524a3dc`, including shared route changes.
This batch does not claim then-current-main equivalence, remote successor CI or
complete manual archive readiness. Integration and publication gates remain separate.

## Current-Main Replay

True merge `140aa46d1043a4a470f88d1d5eb3a1a3b5abffbe` has ordered parents
`8d47548c93d4583eafae6bdae63b5d3c5230f211` and then-current main
`aebed089654f756a76b024a98e051f65e59a1969`; tree
`76985019006378fe117f91bb7368cc1749d16280`. The merge is conflict-free,
with no manual resolutions. The shared route delta relative to main contains only
the manual archive imports/factories; main's record authorization-before-liveness
change is preserved and its 33 behavior tests pass alongside 115 archive tests.

Post-merge local evidence: 148/148 focused tests, complete isolated checkpoint DB
driver including prior neighbors, acceptance TypeScript, static wiring 37/37 and
full S5 pass. Logs are `/private/tmp/tm-manual-current-main-{unit,db,wiring,s5}.log`.
Owned DB/connections and temporary cluster are removed. First-parent diff-check
reports seven existing main documentation EOF blank lines; these unrelated files
are not edited. The candidate-versus-main diff-check is the owned-change gate.
This records local replay, not new remote CI, archive publication or deployment.

## Manual Attachment Intent Acceptance

Successor to `c8dbf4ad88466b3245161e0dcdedd566f21bd2a5` reuses the source-pin
claim helper during admission. Synthetic PostgreSQL fixtures contain a live and a
deleted attachment row. The exact catalog assertion requires both intents, the
generation's owner/fence and exact database lease, mutable availability and null
immutable-version/content-hash/content-size. Request replay leaves exactly two pins.
Injecting a values-bearing error on the second pin produces only
`RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED`; generation/request/first pin all roll
back. A mutation filtering out deleted candidates fails the exact two-pin assertion.
The filter is restored before final verification.

This gate neither reads attachment bytes nor writes customer/local attachment files.
It does not establish provider receipts, complete attachments_index, permission
evidence or catalog publication. The tests use only a disposable owned database.

Final verification includes conflict-free true merge
`11290b272b9940f5bc0473c25902c4a916f1f4b6` (parents
`9bc144d4c9bdb129cf7bbb2021bee010da55c493` and main
`3c6c28958c2ce51334b8f02df13272ef0ae77889`). Full owned-cluster acceptance,
30-migration replay and prior DB neighbors pass; cleanup reports zero connections
and database, with the temporary cluster removed. Source-pin wiring/source/worker
and new-main comment route tests pass 114/114. Acceptance TypeScript, scoped lint,
static wiring 37/37 and full S5 pass. Local logs:
`/private/tmp/tm-manual-attachment-{final,unit-final,wiring,s5}.log`.
No new remote terminal CI result is implied by these local results.

## Physically Purged Attachment Refusal

The synthetic driver marks its deleted attachment's blob physically purged, then
attempts a fresh manual request. Admission must return only
`RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE`; generation count, durable request
lookup and source-pin count prove zero partial admission. Existing live/deleted
non-purged candidates remain the positive control. This is a catalog refusal test,
not an assertion that unmarked attachment bytes are available or immutable.

Read-only source audit found `StorageService.downloadByKey` has no versioned-source
contract. The existing archive object-store validates immutable destination objects,
but does not prove the legacy attachment source was immutable during copying.
No customer path was read; no alternate source assurance was invented.

Mutation bypassing the purged-marker guard produces `Missing expected rejection`
for the exact unavailable code. Restored final acceptance passes on merge
`18f73f5b3988da6391f9063249ac5595dfa1c747`, whose second parent is docs-only main
`8b6aea8b725a1c7f4c9b0746851d51a59e7d1bb4`. Owned database/connections and cluster
are removed on both results. Source/source-pin wiring/worker unit tests: 57/57;
acceptance TypeScript, scoped lint, static wiring 37/37 and full S5 pass. Logs:
`/private/tmp/tm-manual-purged-{final,mutation,unit,wiring,s5}.log`.

## Server-Owned Nonce Reservation

Local bounded delta from `21c5ac49ec8136a5db26ca4d8e43db0cbc52430a` replaces
the caller's reservation callback with the manual continuation's transactional sink.
The existing nonce registry remains authoritative. The synthetic driver proves:

- The caller-owned callback is never invoked; exactly ten registry rows exist.
- An independent connection inside the first upload callback sees all ten committed
  rows. Interrupted upload resumes the original prepared sections without another
  capture, DEK or reservation.
- Pre-inserting the final section reservation makes capture fail with the existing
  values-free `RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED`. The first nine inserts
  roll back, the original conflict row remains, and no prepared envelope or upload
  is produced. Existing crypto unit coverage supplies reserve-before-seal ordering;
  this DB test does not independently instrument AES calls.
- Restoring the caller-owned sink is a discriminating mutation: the exact callback
  assertion fails (`10 !== 0`). Restoring the implementation returns the full driver
  to green. The initial conflict test used an incorrect expected error-code spelling;
  that test expectation was corrected to the existing crypto contract.

Final owned-cluster acceptance passes, including the 30-migration replay and earlier
DB neighbors. Database/connections are zero and the owned cluster is removed.
Worker/crypto unit tests pass 73/73; acceptance TypeScript, production-file ESLint
and static wiring 37/37 pass. Logs are local evidence only:
`/private/tmp/tm-manual-nonce-{final,mutation,unit,s5}.log`.

This checkpoint does not claim fresh remote CI or then-current-main equivalence.
PR #5849's preceding head had one cloud schema-gate timeout; it is not classified
as a flake. Source seals, immutable attachment copy, object receipts and catalog
publication remain separate incomplete gates. No customer storage, flags or
deployment are involved.

## Custody-Interval Source Drift

The follow-up synthetic regression changes a captured record from a second database
connection inside `produceGenerationDek`, after the initial source checks but before
nonce reservation. The server-owned sink must reject with
`RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED`, leave zero nonce rows and no prepared
envelope for that generation, and invoke no upload callback. This does not claim a
final publication fence: source may still change after the reservation transaction.

Mutation replacing the sink's transactional source recheck with its cached source
entry produces `Missing expected rejection` in this new case. Both mutation and
restored runs clean their owned database/connections and temporary cluster.
The test-only wrapper forwards the complete custody input, including generation ID.
Logs: `/private/tmp/tm-manual-custody-drift-{mutation,final}.log`.

Preceding main integration `b49d82ec91d455319bd966cc1c77e4d8f5f4bdeb` has ordered
parents `e43eb22869eaf5858b725f336380580c2ddc68bc` and
`bb77ca5f2ce3c2825265ec8877861d367d017ead`. The merge had no conflict or manual
resolution; official provenance comparison was zero differences. Full owned-PG,
73 worker/crypto tests, static wiring 37/37, acceptance TypeScript and full S5 passed
on that merged tree. Its main-relative whitespace check passed; two unrelated PLM
docs inherited trailing blank lines from main and were not edited. Remote CI is
separate evidence and is not implied by these local results.

## Integrated No-Attachment Source Seals

The manual nonce transaction now calls the existing bootstrap/checkpoint consumer
after its fresh fenced source checks. The driver compares all nine persisted
snapshot-member row counts and hashes to canonical captured rows, including empty
attachment/audit sections. The first request proves bootstrap; a subsequent request
proves repeat checkpoint and ten uploads. A final-section nonce conflict leaves no
snapshot members, proving the preceding seals rolled back with nonce reservation.

Mutation disabling both consumer calls fails the exact first nine-member comparison
(empty result instead of nine canonical members). Restored full isolated-PG acceptance
passes; database/connections are zero and the temporary cluster is removed. Logs:
`/private/tmp/tm-manual-seals-{mutation,final,unit,wiring,s5}.log`.
Acceptance TypeScript, scoped source ESLint, worker/crypto 73/73, wiring 37/37 and
full S5 pass. No migration or workflow changes are part of this delta.

The continuation currently refuses attachment candidates and accepts zero-row
audit-only permission evidence. Derived coverage is still a synthetic placeholder in
this test; these seals are not complete publication, retention/prune authority or a
restore grant. Final publication checks and immutable attachment support remain open.

## Real Source Coverage Integration

The subsequent implementation supersedes the preceding seal-in-nonce ordering.
It seals and reads the actual nine revisions, ten operation endpoints and nine
snapshot memberships in a short fenced transaction. The existing canonical snapshot
planner derives the encrypted coverage section from those rows, with canonical UTC
timestamps and decimal sequence strings. It never trusts callback coverage bytes.
Custody remains outside the transaction; the later nonce transaction repeats source
and authority checks. Historical seals can remain after nonce failure, while nonce
batch rollback, no prepared ciphertext and no upload remain mandatory. These seals
do not publish an archive or authorize history pruning.

The full synthetic driver supplies deliberately bogus callback coverage, then decrypts
the server-created section after interruption/resume. It requires 28 entries with
exact 9/10/9 kind counts and independently rehashes the database snapshot endpoint.
The nonce-conflict test now requires the original historical seal set to remain and
still proves no prepared ciphertext/upload. The earlier empty-seal expectation failed
on the first run, as expected for this documented ordering change, and was updated.
The initial TypeScript pass also caught query-row typing that was corrected before
final verification.

Mutation dropping one real coverage candidate must fail the decrypted count assertion;
the complete candidate set is restored before final gates. Logs:
`/private/tmp/tm-manual-coverage-{mutation,final}.log`. This is no-attachment internal
acceptance, not a provider receipt, finalized catalog entry or restore grant.

Final local gates: owned full-PG acceptance and cleanup pass; snapshot/coverage/worker
unit neighbors 3 files, 66/66; acceptance TypeScript, scoped source ESLint,
static wiring 37/37, full S5 and diff check pass. The mutation fails precisely
`27 !== 28` in the decrypted coverage assertion, then restoration is green.
No new remote CI result is claimed for this local follow-up.

## Local Ciphertext Upload And Receipt Integration

An internal factory using the canonical recovery authorizer composes the existing
transaction-guarded PUT/HEAD compiler with the database uploaded-receipt helper.
Acceptance resumes an already prepared ten-section envelope into an owned temporary
filesystem provider. Each callback deliberately supplies different plaintext-like
bytes; provider GET must return the original persisted ciphertext instead. Two complete
resumes leave exactly ten `section` receipts, all `uploaded`, never `verified`.

A separate connection deactivates the synthetic actor during provider HEAD. The
post-IO authorization check must refuse and leave zero receipts for that generation.
Mutation bypassing that check fails with one unauthorized receipt instead of zero;
it is restored before final gates. Database and provider fixtures are disposable.
The first development runs exposed a test transaction-adapter mismatch, a wrong
receipt table name and a missing test import; these were corrected without changing
the existing storage/receipt authorities.

Logs: `/private/tmp/tm-manual-object-upload-{mutation,final}.log`. No manifest/root
receipt, verified transition, final publication, local custody integration or customer
storage acceptance is claimed by these section-upload tests.

Final gates: complete owned-PG acceptance and cleanup pass; receipt-compiler/worker
unit neighbors 2 files, 23/23; acceptance TypeScript, upload-module ESLint, wiring
37/37, full S5 and diff check pass. The owning temporary provider directory is removed
by the driver's final cleanup. All plaintext and storage paths are synthetic.

## Manual Capture With Real Local Custody

Follow-up acceptance is based on exact product head
`47c2942bd0b6232719645b18ce1e749e5d8af585`. No production changes are necessary:
the existing opaque local capability already satisfies the manual crypto path.

The driver creates a real encrypted custody backup and retains it through the
existing immutable custody store, outside its owned archive root. It registers the
local key in the disposable catalog, manually captures with that capability, and
uploads ten ciphertext sections through the real temporary filesystem provider.
After locking the original custody session, a fresh session reads the saved backup,
unlocks and unwraps the generation DEK, and authenticates/decrypts all ten stored
prepared sections. Each resulting plaintext matches its authenticated SHA-256.
Wrong secret, wrong generation and modified wrapped-DEK bytes refuse with the exact
values-free local custody code. Locked-origin-session upload resume leaves exactly
ten uploaded receipts and does not capture or encrypt again.

This uses a fresh session, not a separate process or a separate-host manual restore.
The existing custody-core tests independently include a separate-process primitive
recovery positive; neither test substitutes for final catalog publication. Keys and
owned sessions are scrubbed/locked in finally; the driver removes its DB, cluster
and temporary storage. Logs: `/private/tmp/tm-manual-local-custody-{final,unit}.log`.
Core/store neighbors pass 2 files, 29/29; acceptance TypeScript and diff check pass.

## Authenticated Manifest In Durable Capture

Implementation range starts at `5137894c1dd7eefb18c68d42e739b28d826befbc`;
this section belongs to its manifest integration child commit. Manual capture now
uses the existing sealed-snapshot compiler and transaction-guarded custody MAC.
The generation's database timestamps and source vector, not callback values, bind
the root. A source/authority/key/owner recheck follows the outside-transaction MAC.
Internal prepared-package version 2 persists the signed v1 manifest object envelope
with the original ciphertext before upload; public archive format remains v1.
Decoding cross-checks scope, anchor, wrapped DEK and all section crypto descriptors.
This is structural validation, not a substitute for restore-time MAC/AEAD checks.

Real PostgreSQL driver proves exact MAC bytes, ten-section manifest, source-vector
binding, altered anchor rejection, no re-sign on resume, and zero prepared package
or upload on MAC failure. Old unsigned version-1 packages remain usable by the
generic legacy fixture but are refused by the manual continuation. Its existing
separate-connection revocation-between-uploads test now runs on a signed package.
The real local custody scenario also passes through this production signing path.

Focused manifest neighbors: 2 files / 21 tests PASS. Acceptance TypeScript and
three-source ESLint PASS. Full synthetic driver PASS, owned DB/connections and
cluster removed. Neutralizing the required-manifest guard makes the old-package
negative fail with `Missing expected rejection`; the guard was restored before the
final full run. Logs: `/private/tmp/tm-manual-signed-manifest-final.log`,
`/private/tmp/tm-manual-manifest-{unit,mutation,restored}.log`.

Not yet delivered: manifest-object PUT/HEAD, verified receipt/catalog atomic
publication, runtime admission/UI, or immutable attachment-source integration.
No flag, customer storage, production, Ready or merge action is implied.

## Durable Manifest Object Receipt

Implementation starts at `c37bfe252906ce562f8c4f5646c2dd64991e7f29`.
The manual manifest uploader reads the original signed envelope from the prepared
package, checks its expiry/source vector against the admitted generation, and uses
the existing guarded PUT/HEAD compiler. It shares the section uploader's pre/post
IO fresh authority and owner checks; caller-supplied bytes are not accepted.
The manifest object id/version/hash are its exact SHA-256. Its receipt has class
`manifest`, null section/attachment identity, and remains `uploaded`.

The synthetic PostgreSQL/filesystem driver verifies ten section receipts plus
exactly one manifest receipt after repeated uploads, GET byte-equivalence with the
durable signed envelope, and zero verified receipts. HEAD failure and actor
deactivation inside HEAD both refuse without registering the manifest. A mutation
that skips post-IO authorization only for the manifest causes the exact revocation
negative to fail with `Missing expected rejection`; it is restored for the final
run. The first test attempt used an incorrect receipt-column name; canonical
`provider_version`/`size_bytes` fixed the test query, not production schema.

Evidence logs: `/private/tmp/tm-manual-manifest-object-{final,mutation,restored,unit,s5}.log`.
Compiler neighbors: 10/10. Acceptance tsc, source ESLint, full S5 and diff-check
pass. Owned database/connections and temporary cluster are removed by the runner.
No catalog transition or finalization is implemented by this adapter; recovery
availability still requires the later atomic verification/publication transaction.

## Atomic Publication And Stored-Object Recovery

Implementation range starts at `590f86bce0c59e87a86007aee60168024aba5e56`.
Sol high's bounded read-only review of that checkpoint found a real critical
integrity defect: section objects omitted the GCM tag, while the reader splits
the final 16 stored bytes as that tag. The new download/decrypt positive failed on
the old implementation with `RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED`. Upload,
object hash/size and final receipt expectations now use `ciphertext || authTag`.
The preceding ciphertext-equality positives are not evidence of recoverability.
The reviewer did not review the subsequently written finalizer; no independent
approval of that new implementation is claimed here.

Finalization uses a pre-authorized immutable prepared payload, verifies its MAC
outside transactions, then rechecks byte equality and all authority inside the
publication transaction. Canonical fence, key/version, live actor/request, writer
exclusion, generation binding/lease/expiry and exact unpruned trust checkpoint
precede source/coverage comparisons. Real immutable history rows produce the
coverage plan; arbitrary caller coverage is never accepted. All eleven receipts,
28 coverage rows and parent `verified/finalized/complete` transition are atomic.

Real-DB negatives cover missing manifest receipt, wrong request identity, stale
key version, rejected MAC, actor revoked during MAC, inactive actor, changed source
and a fault at the final parent UPDATE. The final-write fault leaves zero verified
receipts and zero coverage rows. Removing the source/hash guard makes the drift
negative red. Removing the MAC-result guard makes the rejected-MAC negative red.
Both guards are restored before the final run.

The real local-custody path resumes uploads with its original session locked,
uses a backup-restored fresh session for MAC verification/publication, and calls
the existing `readRecoveryArchiveCompleteSectionsInternal` against the actual
filesystem objects. All ten sections open; records=1 and coverage=28. This is a
synthetic internal reader proof, not an enabled HTTP restore/apply or customer UAT.

Logs: `/private/tmp/tm-manual-object-auth-tag-red.log`,
`/private/tmp/tm-manual-finalization-{negative,mutation,authenticated-final,reader,mac-mutation,final,neighbors}.log`.
Reader/compiler neighbors: 2 files / 25 tests. Acceptance tsc and source ESLint
pass. The driver removes its owned DB, connections and cluster. A test injection
was adjusted after MAC verification introduced a read transaction: source drift
is injected only into the final transaction so rollback restores the fixture.
No migration/flag/deployment or customer data change accompanies this slice.
