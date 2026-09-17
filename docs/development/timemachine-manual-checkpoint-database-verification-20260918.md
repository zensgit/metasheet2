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
NODE_ENV=test pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-manual-checkpoint.mts
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

Remaining: required-CI wiring/remote proof
for this new acceptance driver; lease takeover and permission-revocation tests;
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
The driver remains local-only until explicit required-CI wiring is completed.

No automatic scheduling, retention policy, cleanup, customer storage, flags,
dispatch, staging, deployment, production, or hard-deleted-table resurrection.
