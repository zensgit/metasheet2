# Attachment Restore Verification

Status: IMPLEMENTATION IN PROGRESS; explicitly composed synchronous attachment
restore passes isolated HTTP acceptance. No production enablement or browser UAT.

Base: `868c8d2b26424fcaa8405661a6999abb17ec6d93` (#5849 merge).
Contract: `e4625f322` (full parent available in Git).
First code checkpoint: `0158b581001d630a470d39b2476c2cfb0c48b16e`.
Source/authorization checkpoint: `19d8e6e49996ff6a1083697dcaa22b118f463a2e`.
File preparation checkpoint: `a4bce2504849293703d3a6aebbc534d16a79cc94`.
Durable ledger checkpoint: `e4b447034a70918866428d355a9285db79d41d14`.
Branch: `codex/timemachine-attachment-restore-20260919`.

## Completed Local Evidence

- Internal descriptive cell planner preserves original reference ordering and
  selected scope without changing input maps or scalar values.
- Explicit empty scope, malformed/duplicate references, missing or duplicate
  attachment index evidence, archived-deleted references, wrong original record/
  field, missing live record and missing selected field fail closed.
- Scalar-only selection and identical attachments remain no-op; restoring an
  empty reference list plans detachment, not file deletion.
- Two files / 24 unit tests PASS: attachment-plan and existing archive-preview.
- Core `type-check` PASS (including archive acceptance script project).
- Source ESLint and diff-check PASS.
- Mutation removes original record/field ownership checks: precisely the two
  ownership cases fail (10 pass / 2 fail). Restore and both suites PASS 24/24.
- Existing installed dependencies were linked into this new worktree; no install
  or dependency/lockfile change.

The helper is not called by runtime yet and is not an authorization proof. Its
new unit file is not yet explicitly enrolled in the required archive CI lane;
local success is not published-head CI evidence. No successor PR is published.

## Source And Authorization Checkpoint

- Attachment-only and mixed scalar/attachment plans project into the canonical
  write-intent shape, preserving live versions, exact changed-field IDs, scalar
  peers and input immutability. Drift, duplicate cells and conflicting ownership
  reject the complete projection.
- The existing canonical plan authorizer accepts a writable attachment field,
  refuses hidden/read-only fields, and rechecks current management authority.
  Omitting attachment changed-field IDs yields exactly two false-allow failures;
  restoring the projection returns the suite to green.
- The real encrypted reader now privately retains authenticated attachment
  generation/workspace/base/sheet/record/field, deleted state, size and media
  type. Restore-source access checks all original identities, refuses archived-
  deleted/missing entries and forged state, and returns defensive binary copies.
  This was exercised through both the internal reader and public complete-state
  reconstruction. It does not invent the absent archived display filename.
- Removing the original record/field checks produced the targeted real-reader
  failure. Restored final run: four files / 58 tests PASS (reader, attachment plan,
  canonical plan authorization and archive preview).
- Core type-check (both projects), source ESLint and diff-check PASS.

These are real reader and authorization-component checks, not end-to-end file
restoration. No storage preparation, metadata update or live restore is enabled
by this checkpoint. The public preview still refuses attachment differences.

## File Preparation Checkpoint

- New internal staging function reads only a reader-authenticated source matching
  its original scope, checks current authorization before reservation, waits for
  the reservation port, and exclusively creates the fixed object path outside
  database transactions. It independently checks readback bytes, digest, length
  and immutable version before calling the verified-receipt port.
- Tests use real encrypted archives and the real local filesystem provider,
  including a freshly constructed read provider. Nine cases cover normal write,
  crash-before-receipt retry, verified retry, conflicting existing bytes, denied
  authorization, transaction-depth refusal, receipt failure, false readback and
  provider mutation. Collision/error never deletes an existing object.
- The reservation/receipt port is a test double here, NOT PostgreSQL durability
  evidence. There is no production ledger adapter, cleanup worker or runtime
  caller yet. Crash/retry in these tests means the owned identity is supplied
  again; it does not prove process-restart recovery from a persistent ledger.
- Removing independent readback hashing makes the false-readback test RED;
  restoration returns the full matrix to GREEN.
- Sol high independently reviewed committed `19d8e6e4` (not this new staging
  module): no P1, one P2 for shallow nested aliases in projected intents. Both
  scalar+attachment and attachment-only negatives reproduced RED. Deep copying
  closes both and preserves input/output detachment. No fresh external approval
  of the later staging module is claimed; the review session is closed.
- Final local matrix: five files / 95 tests PASS, core type-check (both projects),
  source ESLint and diff-check PASS. Log:
  `/private/tmp/tm-attachment-stage-verified-20260919.log`.
- Latest merge-main check snapshot: 27 checks, only Node20 pending, no failed
  check. Not yet claimed terminal combined-main green.

## Durable Ledger Checkpoint

- The PostgreSQL staging identity is keyed by actor/token hash/attachment and
  binds the complete archive/original scope, source version, digest, size and a
  unique object UUID. Scope/content cannot be rewritten; the only implemented
  state transition is reserved to verified. This does not yet implement applying
  or retiring prepared objects.
- Each adapter call owns and completes a transaction before file I/O. Source
  archive is locked before the stage row in both methods. Current authorization,
  source state and expiry are checked again, including verified retries.
- Isolated PG15 proves concurrent same-request identity, changed-content refusal,
  new-pool replay, exact verified receipt, authority denial, expiry rejection,
  immutability, empty down/down/up and populated-down refusal. Dropped NOT NULL,
  disabled row/truncate triggers, absent unique, deferred primary key, CHECK(true)
  and replaced function all make migration replay RED; transaction rollback and
  canonical replay restore GREEN. Removing the adapter's exact identity compare
  makes changed-content replay falsely succeed and the gate RED.
- The focused ledger fixture uses a minimal owning archive table and does not
  claim the whole production archive admission protocol. Separately, the complete
  owned-cluster driver passed fresh full migration and replay, 32-migration census
  (989 catalog objects; fingerprint
  `e89ec920a16e18b651df5a062a4ab31183010fa43d8c93472a3584c8e68d9d3c`),
  historical neighbors 59/59 and 127/127, manual attachment capture and HTTP scalar
  restore. The driver then runs the new ledger gate unconditionally.
- Initial full-neighbor failure was new-child FK cleanup omission in the older
  migration suites. The existing empty-layer suspension helper now unwinds and
  restores this layer; production FK and nonempty-down guards remain intact.
- Default-driver removal mutation and new migration removal mutation are pinned
  in the wiring contract: 37/37 PASS. Core type-check, source ESLint and diff-check
  PASS. All owned databases/connections and cluster directories were cleaned.
- Log: `/private/tmp/tm-attachment-stage-full-neighbors-20260919.log`.
- Merged #5849 base `868c8d2b...` now has 29 terminal checks, zero pending/bad.
  This is base evidence, not CI for this unpublished successor.

## Late Purge Completion Protection

- Guarded direct/orphan/sweep completion stamps require the claimed storage path,
  a deleted row, an outstanding purge claim and no previous completion. An old
  storage callback cannot mark a restored or replacement attachment as purged.
  Flag-disabled legacy stamp SQL is unchanged.
- Attachment service/cleanup unit tests: 49/49 PASS, including stale completion
  counted as skipped rather than deleted. Core two-project type-check PASS.
- Owned PostgreSQL stage gate: active row refused; old path after replacement
  refused; matching deleted object stamped once; repeat refused. Ledger gates
  remain green. Database/connections zero and owned cluster removed.
- Mutation removed the storage-path predicate: real PostgreSQL assertion at
  `verify-recovery-attachment-stage.mts:43` failed (true versus false). Restored
  implementation passed. Logs: `/private/tmp/tm-attachment-purge-path-mutation-20260919.log`
  and `/private/tmp/tm-attachment-purge-path-restored-20260919.log`.
- This is a restore prerequisite, not metadata writeback or browser acceptance.

## Metadata Transaction Participant

Exact code checkpoint: `b50271ab2ef1c54ddb1d7751d2af0b546dd61b1d`, parent
`2ba545173` (late purge completion protection). Local only; no remote CI or
successor publication is claimed.

- New internal participant locks the verified source/stage and existing original
  attachment metadata, checks actor/token/object/source identity, original row and
  field existence/type, retained metadata fingerprint and current authorization.
  It preserves filename/media metadata, changes storage identity and clears purge/
  deletion markers inside the caller transaction. No public entry point added.
- Owned PostgreSQL positives/negatives cover authority denial, zero transaction
  depth, actor/token/object/field substitution, unverified reserved stage, stale
  fingerprint, missing original record, changed field type, metadata/provider
  drift, successful metadata update and stale retry rejection.
- A forced later failure rolls the entire metadata row back byte-equivalently.
  This uses a synthetic enclosing transaction, NOT actual record/history apply.
- Removing the metadata hash check causes an expected-rejection failure at
  verifier line 135; removing the verified-state check causes one at line 144.
  Both were restored and the complete stage gate passed afterwards.
- Full owned driver: fresh migrations/replay (32 migration census, 989 catalog
  objects), historical neighbors 59/59 and 127/127, existing encrypted capture/
  reader and HTTP scalar restore, plus stage/metadata gates PASS. Fingerprint
  remains `e89ec920a16e18b651df5a062a4ab31183010fa43d8c93472a3584c8e68d9d3c`.
- Focused unit neighbors: six files / 118 tests PASS. Wiring contract: 37/37 PASS.
  Core two-project type-check, new source ESLint and diff-check PASS. All owned
  databases/connections and cluster directories removed.
- Logs: `/private/tmp/tm-attachment-metadata-{full,restored,unit,wiring}-20260919.log`,
  `/private/tmp/tm-attachment-metadata-hash-mutation-20260919.log`, and
  `/private/tmp/tm-attachment-metadata-verified-mutation-20260919.log`.
- Sol high bounded read-only review was closed while running after its time
  limit, without a terminal verdict. No independent approval is claimed.

## Preview Authority And Plan Identity

Exact code: `359935892af0c13e73b3c432b7b71f9b1ec6e597`; main rechecked
`868c8d2b26424fcaa8405661a6999abb17ec6d93`. Local only.

- Production preview now includes real attachment field/reference deltas in
  authorization and the blocked summary. Denial returns the existing values-free
  authority error. Authorized attachment changes still have no executable token.
- Internal sync-plan v2 binds a canonical closed metadata roster, with unique
  attachment IDs, original record/field scope validation and detached frozen
  entries. Omitting the roster retains the exact existing v1 hash; an explicit
  empty roster is a distinct v2 identity, not an accidental downgrade.
- Tests change every identity axis, reject malformed/extra/duplicate/out-of-scope
  entries, and prove source mutation cannot change the compiled plan.
- Mutation omitting roster hash content: 1 failure / 8 passes. Mutation omitting
  attachment write projection: 3 failures / 10 passes, including permission denial.
  Both restored; focused five-file suite 79/79 PASS.
- Full owned DB driver PASS, including fresh/replay 32/989 catalog census,
  59/59 + 127/127 historical neighbors, encrypted capture, existing scalar HTTP
  restore and the new stage/metadata participant gates. All DB/connection/cluster
  residue zero. Core type-check, source ESLint, wiring 37/37, diff-check PASS.
- Logs: `/private/tmp/tm-attachment-preview-binding-{full,restored,wiring}-20260919.log`,
  `/private/tmp/tm-attachment-plan-hash-mutation-20260919.log`, and
  `/private/tmp/tm-attachment-preview-auth-mutation-20260919.log`.
- No new external review this checkpoint. The production preview does NOT yet
  collect database metadata fingerprints, mint v2 identities or invoke attachment
  apply. No attachment restore browser/UAT evidence is claimed.

## Canonical Sync Transaction Integration

Exact code: `19f90ced8b09ebefc1b3cb6b1283c7fcde93b465`; remote main
rechecked `868c8d2b26424fcaa8405661a6999abb17ec6d93`.

- The internal materialized sync executor now validates the preparation roster
  against the token's v2 plan hash, rebuilds attachment field changes after the
  existing fence/row/schema checks, and submits those fields to locked plan
  authorization. Scalar/link projection remains unchanged without a batch.
- The batch requires exactly all before/target metadata identities, exactly the
  target set of verified stages, exact original scope and current metadata hashes.
  Metadata and record reference CAS now share canonical history/seal, token burn
  and receipt transaction. No public HTTP attachment restore is enabled.
- Four real-DB cases prove success, later-write rollback, authorization denial and
  metadata drift. Success verifies metadata path identity, restored record data,
  version increment, attachment-bearing history patch, one receipt and refusal of
  the second token execution. Failure cases pin zero history/burn and unchanged
  record/metadata. These are direct internal-kernel calls with synthetic verified
  stage rows and authority callbacks, NOT file IO or end-user permission UAT.
- Bypassing the batch apply call yields two exact failures: unchanged tombstoned
  storage metadata on success, and drift incorrectly accepted. Restored GREEN.
- Full D5 suite 44/44 PASS (including the four new cases); historical migration
  neighbors 59/59 and 127/127 PASS; full fresh/replay/manual capture/scalar HTTP
  and stage/metadata gates PASS. Owned DB/connections/cluster residue zero.
- Five focused unit files 59/59 PASS; core two-project type-check, source ESLint,
  diff-check and wiring contract 37/37 PASS. No new external review this checkpoint.
- Logs: `/private/tmp/tm-attachment-canonical-{apply,mutation,full,unit,wiring}-20260919.log`.
  The initial fixture used the legacy string actor ID and correctly failed the
  UUID stage boundary; the new fixture now uses a synthetic UUID, without relaxing
  production validation. The successful full log has no skipped D5 tests.

## Durable Adoption Checkpoint

Exact code: `0ddbab86007424ebb72c740ee76f3e87872c865e` (local only).
Six code/test files; no public restore entry point enabled.

- Verified stages transition once to applied, carrying the canonical operation
  and displaced storage identity. The BEFORE guard locks and checks the old
  attachment binding before replacement; the deferred AFTER guard checks the new
  object, original record reference, receipt and token burn at transaction commit.
  Applied rows remain immutable. This does not yet implement physical cleanup.
- Full D5 real-DB suite 47/47 PASS, including success, rollback, denial, drift,
  missing receipt, wrong adoption operation and wrong displaced storage path.
  All refusal cases preserve metadata/record state and leave no applied journal,
  canonical history or token burn. These are internal-kernel synthetic fixtures,
  not public HTTP attachment restore or browser UAT.
- Missing receipt first triggers the existing token-burn receipt guard; the
  initial new-error expectation was corrected, not the production guard weakened.
- Neutralizing the deferred adoption guard makes only wrong-adoption falsely
  succeed; neutralizing the original-binding guard makes only wrong-displaced
  falsely succeed. Each mutation was restored before final unfiltered testing.
- Full fresh/replay: 32 Time Machine migrations, 995 catalog objects, repeated
  fingerprint `ce2c18ede8fb173e59f9171aee86c4f50a1ace81f5092f81119625ed40162110`.
  Historical neighbors 59/59 and 127/127 PASS; existing manual capture, reader,
  scalar HTTP and stage/metadata gates PASS. Owned DB/connections/cluster residue 0.
- Unit neighbors 3 files/40 tests; two-project typecheck, source ESLint, wiring
  37/37 and diff-check PASS. The temporary D5 mutation filter was removed; the
  committed driver still runs the whole D5 file without a title filter.
- Sol high identified the original displaced-binding P2, now fixed and killed
  by the dedicated mutation. Narrow follow-up: no P1/P2 in that fix; session
  closed. It does not approve public facade, cleanup or the complete product.
- Logs: `/private/tmp/tm-attachment-adoption-final-20260919.log`,
  `/private/tmp/tm-attachment-adoption-mutation-20260919.log`,
  `/private/tmp/tm-attachment-displaced-mutation-20260919.log`, and
  `/private/tmp/tm-attachment-adoption-{unit,tsc,lint,wiring}-20260919.log`.

## Authenticated File Facade Checkpoint

Code commit: `e750e620fcaee89ff8a15aba30205a2f30d022a7`.

- Actual authenticated binary reader -> durable staging -> canonical attachment
  metadata/reference/history/receipt -> original byte readback PASS. This uses
  synthetic authorization and a test-issued v2 token, not public preview or UAT.
- Full-read denial, retiring key and active hold refuse before upload. Injected
  upload failure leaves record/version unchanged and one reserved object; retry
  adopts the same object identity. Consumed-token replay refuses without upload.
- Removing the prepared batch from the facade produces the exact identity-invalid
  RED; source restored before the final full run.
- Final unfiltered owned PostgreSQL runner PASS: D5 47/47, historical neighbors
  59/59 and 127/127; 32 migrations / 995 catalog objects with repeated fingerprint
  `ce2c18ede8fb173e59f9171aee86c4f50a1ace81f5092f81119625ed40162110`.
  Owned DB, connections, cluster and temporary storage residue zero.
- Seven unit files 92/92, two-project typecheck, source ESLint, wiring 37/37 and
  full sealed-export S5 PASS. S5 initially lacked local mssql resolution; rerun
  used the already-installed package through temporary NODE_PATH, without install.
- Sol identified missing pre-IO source authority and escaping structured refusal;
  both were fixed and tested. Narrow terminal review found no remaining P1/P2 in
  orchestration, not an approval of cleanup, public restore or the complete product.
- Initial fixture failures exposed absent live reference/sealed history/original
  scope and an inactive test fence. Fixtures were corrected without weakening
  production validation. Temporary test filters were removed before the full run.
- Logs: `/private/tmp/tm-attachment-facade-{final,mutation,unit,tsc,lint,wiring,s5}-20260919.log`.
- Successor remote exact-head CI has not yet been collected.

## Two-File Failure And Retry Checkpoint

Test commit: `0c287ef7aab36b98e97d5b7baa838dcea8bdb159`.
Published carrier: Draft/HOLD PR #5882. No public runtime enablement.

- The real manual capture fixture now seals two original attachments in the same
  original cell. The first upload succeeds and the second fails. Record data and
  version and both complete attachment metadata hashes stay unchanged. Durable
  stage states are exactly one verified and one reserved, not applied.
- Retry preserves both object IDs, performs only one additional upload, commits
  both stages applied, restores both original byte sequences and rejects consumed
  token replay without another upload. This is resumable preparation, not proof
  of abandoned-object cleanup or a final SQL-failure rollback across two files.
- Full owned runner PASS: 47/47 D5, 59/59 and 127/127 historical neighbors, fresh
  and repeated migration catalog 32/995 with the preceding exact fingerprint;
  existing capture/HTTP/stage participants PASS; owned database, connections and
  cluster removed. The final commit only clarified the successful console label
  after this run; its test assertions and production bytes were unchanged.
- Mutation: uploading a verified object again makes the focused verified-retry
  test RED on the unexpected upload event. Restored production file byte-equal;
  full reader 27/27 PASS; two-project typecheck and diff-check PASS.
- Logs: `/private/tmp/tm-attachment-two-file-{final,mutation,unit,tsc}-20260919.log`.
  This mutation is a focused reader test, not a second full database mutation run.
- Remote checks for the new follow-up head are pending publication/rerun; earlier
  head checks are not evidence for this commit.

## Transaction Failure Checkpoint

Test commit: `a60a3d683280e6faeb7253c574bea6c94e0c62bd`.

- After both original files are prepared, the production facade is interrupted
  after its second live attachment metadata UPDATE, then independently before
  its final sync receipt INSERT. The latter point follows record/history writes,
  token burn and operation sealing inside the same real PostgreSQL transaction.
- Both injected faults are reached with exactly two metadata updates. After each
  rollback, the live record data/version and both full attachment metadata hashes
  match their before-images. Revision/operation row counts are unchanged; token
  burns and receipts remain zero. Both stages are verified, with applied operation,
  time and both displaced storage fields NULL. No partial adoption remains.
- The original signed token subsequently succeeds and adopts both existing files
  without another upload. This establishes rollback/retry for these two precise
  failure points, not arbitrary crashes or abandoned/displaced-object reclamation.
- Terra read-only review found no P1 and requested an explicit displaced file-ID
  assertion. Added it and reran the full owned runner: 47/47, 59/59, 127/127;
  migration replay 32/995 with unchanged fingerprint; real two-file flow PASS;
  DB/connections/cluster/storage cleanup completed. No broad product approval.
- Typecheck, wiring 37/37 and diff-check PASS. This is fault injection, not a new
  production-guard mutation; earlier guard mutation evidence remains separate.
- Logs: `/private/tmp/tm-attachment-transaction-failure-reviewed-20260919.log`,
  `/private/tmp/tm-attachment-transaction-failure-{tsc,wiring}-20260919.log`.

## Ownership And Durability Checkpoint

Code: `a6cad9ecb06a70dbdfce6bb8627b1242c4aa53a5` followed by
`b1227f32ac86be4243e58d11d4fb6444a2b87344`.

- Real local filesystem tests reject unowned matching bytes, wrong ownership and
  symlinks. Before-open, already-open and completed-upload retirement cases prove
  late writes cannot recreate the payload after the internal barrier succeeds.
- Marker write and marker sync faults leave no stable partial reservation; a new
  provider retries successfully. Payload sync failure is reached and refuses
  before the verified ledger transition. Restored reader 36/36; reader plus three
  storage neighbors 4 files / 83 tests PASS.
- Mutations: bypass reservation accepts unowned bytes (RED); remove tombstone
  permits late writes (three RED); remove payload sync accepts durability failure
  (one RED); create stable directory before marker leaves poisoned reservations
  (two RED). Every mutation was restored before final verification.
- Full owned PostgreSQL runner on the durability code PASS: D5 47/47, historical
  neighbors 59/59 and 127/127; fresh/replay catalog 32 migrations / 995 objects,
  unchanged fingerprint. Authenticated two-file facade, upload/metadata/receipt
  fault rollback and same-token reuse PASS. Owned database/connections, stage DB
  and temporary cluster cleanup completed.
- Core typecheck, scoped source ESLint, exact-anchor wiring 37/37, archive wiring
  6/6 and diff-check PASS. Prior ownership checkpoint S5 PASS; no provenance-bound
  workflow or plugin files changed in the subsequent durability fix.
- Sol read-only review found two P2 durability issues in the initial checkpoint.
  Both were fixed and independently re-reviewed with no P1/P2 in those two fixes.
  The trusted-exclusive-root P3 remains explicit; this is not broad product
  approval. Review session closed; it did not run tests or modify files.
- Logs: `/private/tmp/tm-attachment-ownership-durable-{restored,realdb,tsc,lint,exact-wiring,wiring}-20260919.log`,
  `/private/tmp/tm-attachment-ownership-{sync,marker}-mutation-20260919.log`.
- These are internal storage and facade results, not public attachment execution,
  abandonment cleanup, shared-NAS certification or real Workbench browser UAT.

## Historical Acceptance Process Budget

Runner commit: `fb335f2177945906c0c123f3514cc154208d061b`.

- Remote `79734540f8fb189da00b67a74f0a121bdf346cb4` Node18/20 both
  failed in isolated manual acceptance, before any successful historical suite
  summary. The final cleanup assertion observed three database connections and
  masked the child failure; the owned outer cluster was stopped and removed.
- Local full D5 takes about 223 seconds against the old 240-second child limit.
  Process timeout is the working diagnosis, not a reproduced Node18 root cause.
  Neighbor budget is now bounded at 600 seconds and outer script at 1200 seconds;
  errors explicitly distinguish ETIMEDOUT from other process failures. No test,
  assertion or zero-connection cleanup requirement was removed.
- Full local rerun PASS again (47/59/127, unchanged 32/995 migration catalog,
  complete two-file facade and stage acceptance, owned DB/cluster cleanup).
  Typecheck and wiring 37/37 PASS. The final type narrowing changes only the
  error diagnostic, not the exercised successful runner path.
- Evidence: `/private/tmp/tm-5882-797345-failed.log` and
  `/private/tmp/tm-attachment-ownership-ci-budget-{realdb,tsc,wiring}-20260919.log`.
  Fresh remote exact-head CI is required before declaring the CI failure closed.

## Expired Stage Cleanup Checkpoint

Code: `87f05247d1cdb9854bcf1f216ecd4a78424e229e` (seven files).

- The server carries the verified signed token's exact expiry into immutable stage
  identity. Retry must match that expiry; active prepare/apply checks database time.
  No retention duration, schedule or public cleanup capability was introduced.
- Real PG + local filesystem prove expired-only abandonment is committed before
  storage retirement. Any attachment metadata reference by file ID or path refuses
  cleanup. A post-retirement failure leaves abandoned/cleaned_at=NULL; retry stamps
  completion, and subsequent replay makes no storage call. Never-started uploads
  are retired safely; late open-descriptor writes cannot recreate the payload key.
- A separate apply transaction acquires the stage before expiry and holds it across
  expiry. `pg_blocking_pids` proves cleanup waits for that exact writer. Apply commits
  its metadata, record reference, token burn and receipt; cleanup then refuses with
  zero storage calls and stage remains applied. This is real lock arbitration, not
  an elapsed-time-only concurrency assertion.
- Mutations: removing the DB expiry guard admits premature direct abandonment;
  skipping file retirement falsely completes; doing file retirement before claim
  commit leaves verified instead of abandoned on failure. Each is RED, restored.
- First full run found seven old attachment transaction fixtures missing the new
  expiry argument (40/47 passed). Fixed that caller to use real token verification,
  not a default timestamp. Restored full runner: 47/47, 59/59, 127/127, two-file
  facade, stage cleanup/race gates PASS; owned DB/connections/cluster removed.
- Fresh/replay: 32 migrations / 999 catalog objects; fingerprint
  `651036c3ffcc978293e9e1bcfeb4de2d33458adfd80b88166ef1b50bf9d90063`.
  Catalog growth is the three expiry/cleanup columns plus their CHECK constraint.
- Unit neighbors: four files / 70 tests, execution/async neighbors three files /
  26 tests PASS. Typecheck, source ESLint, wiring 37/37, S5 and diff-check PASS.
- Sol bounded read-only review: no P1/P2 in expiry/abandonment/storage-order logic;
  no tests or edits by reviewer; session closed. This does not approve the entire
  attachment product or displaced-object cleanup.
- Logs: `/private/tmp/tm-attachment-abandon-full-restored-realdb-20260919.log`,
  `/private/tmp/tm-attachment-abandon-{expiry,storage,commit-order}-mutation-20260919.log`,
  `/private/tmp/tm-attachment-abandon-{neighbors,execution-neighbors,final-tsc,lint,wiring,s5}-20260919.log`.
- Public runtime, automatic scheduling, old displaced-object cleanup and browser
  UAT remain unimplemented. No customer storage or real environment was accessed.

## Public Synchronous Attachment Checkpoint

Code: `c97550f243d82060e1af88c1a90864cde78e4c93`.
Tree: `b93f8883072586cad761331f71c4470e03dce878` (eight-file code/test delta).

- Public preview fingerprints the database metadata of both removed and restored
  attachment references under original sheet/record/field ownership. The v2 plan
  is rederived and matched before file staging; final canonical apply still
  rechecks metadata, current permission, record/schema locks and token authority.
- The optional server-owned application port snapshots and binds all three
  methods. Incomplete ports refuse before resolving DB; absent ports preserve the
  attachment refusal. Over-threshold attachments remain blocked as a whole.
- Real HTTP preview covers whole sheet, selected records and selected fields;
  scalar-only no-op remains unchanged. Public execution restores two original
  binary files to their existing original record/field, increments version once,
  and refuses consumed-token replay. Anonymous calls are 401. Metadata drift and
  altered selected fields are 409 with no new stage or live record change.
- First full run correctly refused an old fixture that inserted an unbound
  attachment into the cell (503). The positive now removes one actual original
  reference instead; no production ownership guard was weakened.
- Full restored owned PG runner PASS: fresh/replay 32 migrations / 999 catalog
  objects, fingerprint unchanged; historical 47/47 + 59/59 + 127/127; prior
  two-file upload/metadata/receipt fault rollback; public HTTP; expired-stage and
  concurrent apply/cleanup arbitration. Database/connections/cluster removed.
- Focused public suites 3 files / 62 tests and sync/async/attachment neighbors
  5 files / 54 tests PASS. Core typecheck, source ESLint, wiring 37/37, full S5 and
  diff-check PASS. No workflow or provenance pin changed.
- Mutation replacing metadata hashes with a constant makes the public-preview
  fingerprint test RED; restored full 62/62 GREEN. No mutation was committed.
- Sol high read-only narrow review found no evidenced P1/P2 in public binding,
  pre-IO validation or capability snapshot. Session closed; it ran no tests and
  does not certify browser, cleanup or asynchronous restoration.
- Logs: `/private/tmp/tm-attachment-public-http-realdb-20260919.log` (initial
  fixture failure), `tm-attachment-public-http-restored-realdb-20260919.log`,
  `tm-attachment-public-{unit,neighbors,metadata-mutation,final-tsc,lint,wiring,s5}-20260919.log`
  under `/private/tmp`. HTTP authentication is synthetic, not Workbench login/UAT.
- Remote exact-head CI for this new checkpoint is pending publication/rerun.

## Synthetic Browser Attachment Checkpoint

Code: `dc589e3e830d1cedaf29b4161839857612590816`.
Tree: `9be618e686b89c8d8820763b3936ccca45a1a245` (five-file delta).

- Chromium 1440/390 passed for both scalar and attachment capture, reload,
  catalog, preview, explicit confirmation and synchronous restore through the
  production modal/client/router. Failed or non-2xx API requests fail the gate.
  Each loop requires exactly one execute request and one executed notification.
- Attachment readback checks the entire record data, exactly one restore version
  increment after the synthetic edit, one restore history entry and both original
  binary payloads through local storage. This is not a browser download test or
  proof that the Workbench grid consumed the notification.
- Initial attachment browser run exposed a shared-client transaction fixture
  problem during concurrent status/catalog reads. The fixture now uses an owned
  pool with per-transaction checkout and async-local depth. Production main pool
  already uses its transaction API; no production database behavior was changed.
- Restored full runner exited 0: historical 47/47, 59/59 and 127/127;
  32 migrations / 999 catalog objects; public HTTP, stage cleanup/concurrency,
  all four browser loops. Owned DB connections, clusters, browser and Vite/cache
  were closed/removed. Log:
  `/private/tmp/tm-attachment-public-browser-restored-20260919.log`.
- Modal/client 2 files / 154 tests, core/web typechecks, scoped ESLint, wiring
  37/37 and diff-check passed. Unsupported-copy assertions were RED before the
  bilingual correction and GREEN after it. Full required-web was not rerun
  locally for this checkpoint; these existing specs retain their two-point wiring.
- Screenshots `tm-manual-http-browser-attachment-{1440,390}.png` in the runner's
  OS temporary directory were visually inspected; no dialog overflow or control
  overlap observed. Authentication is synthetic and edits are synthetic SQL.
- Luna narrow read-only review returned no evidenced P1/P2 before session close.
  It made no edits and ran no tests; this verdict covers this five-file patch,
  not full Workbench UAT or the complete attachment product.
- New exact-head remote CI remains pending publication. No real environment,
  flags, dispatch, deployment or customer storage was accessed.

## Local Startup Binding

Local startup binding checkpoint: code
`6cb20af35dbd02a5f835027cd5190c917d1dd610`, tree
`3447686772f4a15b0501252fd6713e5e8d92b84e` (four files).
The actual local launcher supplies the existing upload/download storage singleton
to custody startup, which forwards it only after unlock. OFF, wrong-secret,
cancellation and root/receipt refusal preserve zero storage resolution; resolver
throw/cancellation reject publication and scrub the supplied secret.

Startup/application focused suites PASS 58/58, core typecheck PASS, startup source
ESLint PASS, D2 archive wiring PASS 6/6, diff-check PASS. The initial new positive
failed because the resolver was never called. Removing composition forwarding
independently failed on missing attachmentStorage; restored suites PASS 58/58.
Logs: `/private/tmp/tm-attachment-startup-{restored-tests,tsc,source-lint,wiring,port-mutation}-20260919.log`.
Launcher ESLint was attempted but excluded by the repository TSConfig (not a
source lint pass); actual launcher OFF/wrong-secret/cancel subprocess tests pass.
No new DB/browser run or independent review is claimed for this binding-only
checkpoint; the previous synthetic router/browser proof is not full launcher UAT.

## Production Download Route Acceptance

Code: `d1ca403ddb8cd85fc28dbf7575d23a9956df808b`.
Tree: `aac0a46df72a9ebf65eeb9b52b91cd3e1a795260` (one verifier file).
The production attachment download route uses the process main pool rather than
the recovery router injection port. The verifier asserts that the initial pool
has zero connections, closes it and binds a pool to the separately verified owned
database. Database name and role are checked before the download route runs.

- Both restored files download byte-identically through the real GET route;
  anonymous calls return 401. These checks also run after each desktop/mobile
  browser restore, in addition to the prior direct storage readback.
- Full `--browser` runner PASS: scalar and attachment 1440/390; historical
  47/47 + 59/59 + 127/127, migration replay, fault rollback and cleanup races.
  Main/download/stage DB connections are zero and databases/cluster removed.
- Core typecheck and diff-check PASS. Log:
  `/private/tmp/tm-attachment-download-browser-20260919.log`;
  typecheck: `/private/tmp/tm-attachment-download-tsc-20260919.log`.
- Download requests are Node HTTP requests using synthetic authentication,
  not browser link clicks or real Workbench login. No new production code,
  permission or flag changed. No new independent-review verdict is claimed.

## Production Login And JWT Checkpoint

Code `4b5a6a52e5593cba730dec97a3e9628a8af7b631`, tree
`4a0e4bbed602bffe73c2786038c532b584f29aa1` (two verifier files).
An isolated synthetic user logs in through the production auth route; attachment
requests and desktop/mobile modal calls use the returned token and production
JWT middleware. Capture/restore/download pass; anonymous and subsequently
deactivated actor downloads return 401. Scalar fixtures retain their earlier
synthetic middleware and are not claimed as production-login coverage.

The first run completed behavioral assertions and DB cleanup but remained alive
because importing auth routes started message-bus resources. It was explicitly
terminated and is not a full PASS. The corrected verifier shuts down that owned
singleton in finally. The complete restored runner exits 0, including four browser
loops, historical 47/59/127, stage cleanup arbitration and zero remaining DB
connections/removed cluster. Core typecheck, JS syntax and diff-check PASS.
Logs: `/private/tmp/tm-attachment-login-browser-restored-20260919.log` and
`/private/tmp/tm-attachment-login-final-tsc-20260919.log`.

Sol high reviewed the permission/original-binding chain read-only at f215ba1f1a:
no P1; P2 was OPEN for generic preparation errors becoming HTTP 500 after permission
or original-binding drift. It ran no tests and did not assess these verifier edits.
Session closed. This checkpoint is local-only pending that bounded fix; remote
CI on f215ba1f1a does not certify it. No Workbench login-page/grid/download-click
acceptance, real environment, flag, dispatch or deployment is claimed.

## Preparation Refusal Fix

Code `6bff7a8d6645644ad07b77b606df265dc2842aa0`, tree
`5e322c08b76f9f513b240b78f727ba0fdbe8aa04` (seven files), closes the
bounded Sol finding above. Named permission errors survive preparation/staging;
original metadata and plan errors use preview-drift. Unknown infrastructure
failures are not relabeled as permission or drift errors.

- Initial unit negatives failed for generic permission/binding errors. Final
  sync-restore/attachment-plan/preview neighbors PASS: three files, 42/42.
- Mutation restoring generic preparation permission failure makes the matching
  unit RED; restored implementation is used for the complete final DB run.
- Production HTTP: field permission revoked after preview returns 403; original
  attachment field binding removed after preview returns 409. Both preserve
  record data/version and stage count. Restored fixture then completes the
  positive two-file restore with exact original-byte downloads.
- Full owned PostgreSQL/browser runner exits 0: 32 migration replay census;
  historical suites 47/47, 59/59 and 127/127; scalar and attachment modal loops
  at 1440/390; production login/JWT/download; fault rollback and cleanup races.
  Owned browser/listeners close, database connections reach zero, databases and
  temporary cluster are removed.
- Core typecheck, five source-file ESLint, D2 wiring 6/6 and diff-check PASS.
- Terra bounded read-only review: no evidenced P1/P2 in the five source files.
  Its initial concern about generic infrastructure errors was withdrawn after
  tracing facade rethrow/HTTP 500; sanitization remains intentional. No tests
  were run by that reviewer; session is closed.

Logs under `/private/tmp/`:
`tm-attachment-refusal-route-final-realdb-20260919.log`,
`tm-attachment-refusal-final-unit-20260919.log`,
`tm-attachment-refusal-final-tsc-20260919.log`,
`tm-attachment-refusal-lint-20260919.log`,
`tm-attachment-refusal-wiring-20260919.log`, and
`tm-attachment-refusal-mutation-20260919.log`.
These are local evidence, not a successor remote CI verdict. No full Workbench
login-page/grid/download-link UAT, runtime cleanup registration, real environment
or customer data acceptance is inferred. #5882 remains Draft/HOLD.

## Field And Record Lock Acceptance

Additional authorization code checkpoint:
`84e975b2b131c1ed0ebadde93f8f5974ca01abfa`, tree
`d6253c6cbeae7d09b7ef14dee5afc49bde9f5946` (one verifier file; no production
change). After preview, both hidden and read-only field rows independently cause
HTTP 403 with unchanged stage count and record. An unrelated locker with no owner
bypass causes HTTP 409 RECORD_LOCKED; live attachment metadata, record data/version,
revision/history counts, preview-token burns and sync receipts remain unchanged.
The fixture lock/owner fields are restored in finally; subsequent positive apply
succeeds exactly once and downloads the original two binaries. This does not
assert zero private staging for the canonical record-lock refusal.

Full owned runner exits 0, including historical 47/59/127, four desktop/mobile
modal loops, production login/JWT/download, cleanup/apply races and zero database
connections/removed cluster. Core typecheck PASS; exact-anchor CI wiring 37/37
PASS; diff-check PASS. Logs:
`/private/tmp/tm-attachment-lock-http-realdb-20260919.log`,
`/private/tmp/tm-attachment-lock-http-tsc-20260919.log`, and
`/private/tmp/tm-attachment-lock-http-wiring-20260919.log`.
No new independent reviewer or record-lock guard mutation is claimed for this
verifier-only extension. Existing production guard behavior was exercised through
the actual HTTP route; remote CI for the new commit is not yet certified.

## Workbench And Reader CI Checkpoint

Code checkpoint: `580577ecda412f0a28e7e017dad58d3f481b19bf`, tree
`691a1d37198e6068db7b3c1058c48737af8b2f7c` (three verifier/test files,
no production change).
Owned runner `TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node
scripts/ops/run-recovery-manual-checkpoint.mjs --browser` exits 0. In addition to
the existing modal loops, production Workbench loops at 1440 and 390 prove real
capture/catalog/preview/confirmation, exactly one execute request, empty-to-two
attachment grid refresh and database/history/binary readback. All API non-2xx
responses remain fatal. Production comment routes, not successful mocks, satisfy
the Workbench dependency reads. Owned database connections are zero and the
synthetic cluster is removed. Log:
`/private/tmp/tm-workbench-archive-final-realdb-20260919.log`.

Earlier runs failed on missing fixture comment routes and a locator matching both
the hidden recycle-bin dialog and archive dialog. These are not counted as passes.
The final run mounts real comment services and selects the named archive dialog.
Both screenshots were inspected. At 390px the full-page image exposes horizontal
Workbench overflow despite a passing dialog-width check; mobile layout remains
OPEN. This is a functional small-viewport result, not responsive-layout signoff.
Full app login/org selection, real cell edits and browser-click download remain
OPEN; HTTP download with an explicit JWT is a different evidence class.

Remote Node18/20 at `2ef3cdcb18a8da647e9e422555629e7748943ac3` failed the same
reader denied-mode stale error expectation. Local reproduction was 1 failed/35
passed. Only denied mode now requires the typed authorization error and exact
`ARCHIVE_ATTACHMENT_STAGE_FORBIDDEN` message; its zero-storage-events assertion
and all other refusal cases remain. Restored reader is 36/36; reader/sync-restore/
attachment-plan/preview neighbors are 4 files/78 tests PASS. Logs:
`/private/tmp/tm-reader-refusal-red-20260920.log` and
`/private/tmp/tm-reader-refusal-neighbors-20260920.log`.
Core typecheck, wiring 37/37 and diff-check PASS. Earlier bounded Luna read-only
review found no evidenced P1/P2 in the initial Workbench oracle; it did not review
the later fixture dependency/locator adjustments. No new full independent verdict
or successor remote CI success is claimed. PR remains Draft/HOLD.

## Original Download Repair

Code `0784b4c1cdb1cc3d16eb4ee24214538b57d619bc`, tree
`d18add79b7230626ba79d85b5fadbe1a8bc4c1be`. Actual Workbench click before the
repair failed 401 versus required 200, independently of the passing authenticated
HTTP readback. Log `/private/tmp/tm-workbench-download-red-20260920.log`.
After repair, the full owned PostgreSQL/browser runner exits 0 at 1440 and 390;
the click obtains HTTP 200 and a completed browser download. No browser-wide extra
headers or query-token bypass is used. This currently tests the first original
download action, not thumbnail/lightbox rendering or full application login UI.
Log `/private/tmp/tm-workbench-download-green-20260920.log`; database connections
zero, synthetic cluster stopped/removed. Original binary fidelity continues to
be checked by the HTTP/database fixture; downloaded-file byte comparison is not
claimed for this browser-click assertion.

Four component/neighbor files pass 27/27. Unit negatives prove denied response
creates no blob/download, unmount aborts and suppresses a late download, and a
hostile stored URL is not used as the authenticated request destination. Removing
the HTTP-success guard makes exactly denied mode RED (1 failed/6 passed); restored
neighbors return 27/27. Logs `/private/tmp/tm-attachment-download-mutation-20260920.log`
and `/private/tmp/tm-attachment-download-restored-20260920.log`.
Application `vue-tsc --noEmit -p tsconfig.app.json` passes. Full web type-check
is NOT green: unchanged `vite.config.ts:28` reports incompatible Vite 5/7 plugin
types in the available dependency tree. No dependencies/config were changed.
Scoped ESLint passes with zero errors/five component-fixture warnings using only
the already installed pnpm-store NODE_PATH (initial parser-resolution attempt
failed). Diff-check passes. The existing attachment-list spec remains covered by
both domain guard and required-web filters; no selectors changed.

Luna's bounded read-only review remained running without a terminal verdict and
was closed; no external approval is claimed. Successor remote CI remains pending
verification. Workbench whole-page mobile overflow and authenticated image preview
remain OPEN. No Ready/merge, flag, dispatch, deployment or real environment access.

## Remaining Acceptance

Image-preview checkpoint `8528aa176d385f0a6134d580c14bbf31d981c327`, tree
`7bbb591fd8b98cfc37b76dd941904d96582f1079`, supersedes the original-download
checkpoint's open image-authentication item. Three initial image cases were RED
because the component never made an authenticated image request. Final component
and seven neighbor files pass 96/96. Removing the post-abort publication guard
makes removed-image mode RED (1 failed/2 passed in the focused image cases);
restoration returns the expanded suite to 96/96. Existing field-panel/drawer
assertions now check blob image sources instead of raw URL strings.

The full isolated runner exits 0 with a real synthetic PNG as the second archived
attachment. All existing binary/hash/history assertions use the same expected
fixture bytes, not substituted text. Both 1440/390 Workbench loops wait for a
decoded thumbnail (naturalWidth > 0), open the lightbox and prove naturalWidth=1
for the one-pixel PNG, then complete authenticated original download. Every API
failure remains fatal. Owned DB connections=0 and the cluster is removed.
Application and backend typechecks pass; scoped ESLint has zero errors;
diff-check passes. The full web project-reference Vite dependency conflict from
the prior checkpoint is not claimed resolved.

Logs: `/private/tmp/tm-image-auth-red-20260920.log`,
`/private/tmp/tm-image-auth-final-20260920.log`,
`/private/tmp/tm-image-auth-mutation-20260920.log`,
`/private/tmp/tm-image-auth-browser-20260920.log`,
`/private/tmp/tm-image-auth-app-tsc-20260920.log`,
`/private/tmp/tm-image-auth-core-tsc-20260920.log`, and
`/private/tmp/tm-image-auth-final-lint-20260920.log`.
Terra medium completed a bounded read-only review of the image component/test
delta: 0 P1/P2. It ran no tests and did not certify the full PR; its session closed.
Whole-page mobile overflow, full app-login/organization-selection UAT, cleanup
composition, broader remaining acceptance and successor exact-head CI stay OPEN.

## Remaining Full-Scope Acceptance

Mobile containment checkpoint `081a2644eb0f38fe3382a834f42b72d961f23a5e`, tree
`b4a15a5456a0f0ab9c5a3a97007959caa3877c0c`, supersedes the earlier observed
whole-page overflow item for the tested Workbench fixture. Baseline assertion
reports viewport=390/document=1365, toolbar-right edge=1364.5625 and banner-right
edge=406. Final owned browser/PG runner exits 0 at 1440 and 390; whole-page width
fits, and in-browser nowrap mutation reproduces overflow before restoration.
Screenshots were inspected at both widths. Existing capture/restore, image decode,
authenticated download, database/history/byte readback and cleanup gates remain
green. Owned database connections=0 and cluster removed. Logs:
`/private/tmp/tm-workbench-mobile-red-20260920.log` and
`/private/tmp/tm-workbench-mobile-green-20260920.log`.

Exact remote `1c0ab0e11da8d33f830ec1594715d6be856cf5e7` domain CI failed one
stale raw-thumbnail-URL assertion in multitable-grid-link-renderer.spec.ts; local
reproduction was 1 failed/5 passed. Test-only commit `4658ac1f07` changes it to
authenticated request plus blob source assertions. Focused image neighbors pass
79/79. The full, unmodified workflow targeted command passes 295 files/4088 tests
in `/private/tmp/tm-mobile-full-domain-guard-20260920.log`. Layout/toolbar/Workbench
neighbors pass 196/196; scoped ESLint has zero errors with existing prop-default
warnings. Syntax/diff checks pass. No new independent layout reviewer is claimed.

Gallery cover images have a separate raw-URL rendering path (not changed here);
their authenticated browser behavior remains an explicit audit item, not covered
by the grid/lightbox pass. Full application login/organization selection, remaining
runtime/cleanup requirements and successor remote CI are still not certified.

## Saved Browser Download Bytes Checkpoint

Code `c6813cf79503794c625fb1bfe4fa07e856470b3c`, tree
`70a75c47761d292b621f064b104c86ba054ed25b`, adds an exact saved-file
oracle to the existing production Workbench synthetic browser loop. At both
1440 and 390, the authenticated original download must identify the expected
attachment, complete without a download error, persist a file, and contain
exactly the original synthetic archive bytes. HTTP 200 alone is insufficient.

The owned full runner passes in
`/private/tmp/tm-browser-download-saved-bytes-20260920.log`; database connections
are zero and the synthetic cluster is removed. Syntax and diff checks pass.
The preceding run in `/private/tmp/tm-browser-download-bytes-20260920.log`
failed because Playwright response.body() returned an empty buffer. That
transport-observation assertion was replaced with the stronger user-delivered
download.path() file read, not relaxed to status-only acceptance. The saved
file contains the exact expected 32 bytes. No claim about the cause of the
empty response observation is made. Existing direct HTTP/storage byte checks
remain unchanged. This is test-only; no new product permission or restore semantic.

Gallery cover rendering and full application login/organization selection
remain separate open acceptance items. No flags, deployment or real environment.

## Authenticated Gallery Cover Checkpoint

Code `f92a6cfcf214b3770fae56384f5e50bc4b889b7d`, tree
`88c4c04e958a30b2a818c8ed8235e26da3f3e8a6`, changes only the existing gallery
component and its already-wired spec. Cover requests use encoded attachment ID
through apiFetch, never the stored URL. Aborted requests cannot publish a blob;
current covers are revoked on metadata/row changes and unmount. Unavailable
covers keep the existing filename fallback.

- Baseline: 4 failed/2 passed, `tm-gallery-auth-red-20260920.log`.
- Focused gallery/attachment neighbors: 16/16, `tm-gallery-auth-green-20260920.log`.
- Remove the abort publication check: removed-row case RED, 1 failed/5 passed;
  restored before final gates, `tm-gallery-auth-mutation-20260920.log`.
- Full unchanged multitable workflow targeted command: 295 files/4091 tests PASS,
  `tm-gallery-full-domain-20260920.log`.
- App-source vue-tsc, scoped ESLint and diff-check PASS;
  `tm-gallery-auth-tsc-20260920.log`, `tm-gallery-auth-lint-20260920.log`.

All logs are under `/private/tmp/`. Bounded Luna read-only review was closed
without a terminal verdict, so no independent approval is claimed. Actual gallery
browser decoding through the owned HTTP fixture remains open; grid/lightbox
browser evidence is not substituted for it. No DB, flags or deployment in this
checkpoint. Successor exact-head CI remains separate.

## Restored Gallery Real Browser Checkpoint

Code `f18bbbc435fa43897135e440884498cdb416c013`, tree
`45897d89579090a4a0fbb347075528f5dce3fd1b`: fixture attachment ordering is
image-first, preserving both original binaries; an owned gallery view uses that
same attachment field. After archive restore, real production Workbench loads
the gallery via its initial view ID. At 1440 and 390, its cover must complete,
have naturalWidth=1 and an authenticated blob source. API failures remain fatal.
Original file download saved bytes and database/history readback still pass.

Full owned PG/browser runner exits 0:
`/private/tmp/tm-gallery-browser-20260920.log`. Owned database/stage connections
are zero, cluster removed, browser/Vite/cache closed. Syntax/diff checks pass.
Screenshots `tm-restored-gallery-1440.png` and `tm-restored-gallery-390.png` under
the OS temporary directory were inspected. The white 1x1 fixture really decodes;
it is not a missing image. However one-column desktop cover height grows with
image aspect ratio, leaving an oversized card: visual sizing is not certified.

This closes the prior gallery authenticated-decoding gap, not full app login,
organization selection, real cell editing or remaining runtime/cleanup gates.
No new permissions, flags, deployment or real data access.

## Gallery Cover Sizing Closure

Code `7912fb96b1c27e4efa71d167a37041bebe67e440`, tree
`16134a74c71078eab7665ebd71d58ecb8ae15083`: existing size values are now fixed
heights, preserving object-fit cover and card layout. At 1440 and 390 the owned
production browser changes small/large/medium using the actual select, requires
PATCH success and exact 108/176/132px cover heights. A temporary height:auto
override must exceed 176px; removal must restore 132px. Both screenshots were
inspected and no longer show the oversized square-image card.

`/private/tmp/tm-gallery-sizing-browser-final-20260920.log` exits 0 for the full
owned migration, recovery, browser and cleanup runner. Connections=0, cluster
removed. Gallery/attachment neighbors 16/16, scoped ESLint, syntax and diff-check
pass (`tm-gallery-sizing-unit-20260920.log`, `tm-gallery-sizing-lint-20260920.log`).
The first sizing attempt timed out on an exact label locator; it is not a pass.
The final locator targets the labeled field's select and awaits selection and
response together, preserving the height assertions and cleanup path.

Sol's separate bounded runtime audit was closed without a terminal report; no
independent verdict or runtime-gap closure is inferred. No new permissions,
flags, dispatch, deployment or real environment access.

## Outstanding Full-Scope Acceptance

Latest bounded cleanup evidence: code
`2aef32ff8edb01981a923bfe7e312164ba626253`, tree
`bd1666275020951b8c0f4c49f749924a39a9768c`. Two new local filesystem cases
first failed (36 existing passed), then reader/application neighbors passed
80/80. Removing exact ownership verification caused the foreign-marker assertion
to fail; restored before final tests. Core typecheck, source ESLint and diff-check
pass. Logs under `/private/tmp/`: `tm-orphan-owned-{red,green,mutation,final,tsc,lint}-20260920.log`.

`tm-orphan-owned-realdb-20260920.log` is a successful full owned runner without
browser: fresh/replay, restore and stage abandonment/apply race gates passed;
owned/stage connections zero, cluster removed. This new filesystem behavior is
directly tested with synthetic local directories, not claimed as a real-DB fault
injection of process death. Terra medium narrow read-only review returned no
P1/P2 and was closed; it is not a full-PR approval. Markerless/partial-proof and
unlink/rmdir-crash leftovers plus displaced objects remain open as described in
the lock. No real storage, public cleanup API or background registration.

Production local startup composition is wired (see the paired runtime audit at
`f0af8722c1`); full launcher/application acceptance is not yet certified.
Public/background cleanup scheduling remains contract-excluded, not implicitly
authorized. Internal expired-stage retirement is locally verified. Open items:
prepared/displaced file
reference-safe crash cleanup; end-user attachment field authorization acceptance;
remaining purge/drift/retry concurrency; async contract;
whole-operation negatives; full Workbench login, field authorization, grid refresh
and browser attachment download acceptance beyond the synthetic modal loop;
required exact-head CI and independent exact-head review.

Next order: prove crash reconciliation ownership without a new retention policy;
complete real application login/org/cell-edit acceptance; audit history/config/
trash/diagnostics against their own locks. Do not substitute repeated image-helper
verification for these remaining gates. Gallery/mobile improvements are now
locally verified, not proof of full Time Machine completion.
`unsupported_attachments` remains for absent/partial ports and over-threshold
attachment selections. Explicit test composition is not production readiness.

Sol high's bounded read-only integration review was closed while running without
a terminal verdict. No external approval is claimed. #5849 post-merge CI later
reached the terminal base result recorded above; it is not successor CI evidence.
No flags, dispatch, deployment, real environment or customer storage/data access.
The read-only nightly plan is in the paired design lock; it has not been executed
against any real environment.
