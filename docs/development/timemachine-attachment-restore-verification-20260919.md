# Attachment Restore Verification

Status: LOCAL IMPLEMENTATION IN PROGRESS; no executable attachment restore yet.

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

## Remaining Required Work

Authenticated-reader integration; prepared file ownership and crash cleanup;
preview/token binding; explicit attachment field authorization; canonical atomic
metadata/reference/history apply; purge/drift/retry concurrency; async contract;
whole-operation negatives; real isolated database/storage and desktop/mobile
browser acceptance; required CI wiring and independent exact-head review.
Existing `unsupported_attachments` remains in force until that chain is complete.

Sol high's bounded read-only integration review was closed while running without
a terminal verdict. No external approval is claimed. #5849 post-merge CI was
still running with no observed failure; PR-head green is not substituted for it.
No flags, dispatch, deployment, real environment or customer storage/data access.
The read-only nightly plan is in the paired design lock; it has not been executed
against any real environment.
