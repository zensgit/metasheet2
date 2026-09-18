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
