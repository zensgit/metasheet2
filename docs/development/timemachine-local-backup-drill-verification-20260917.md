# Local backup-set recovery verification

Status: local checkpoint, not published or production acceptance.
Base: `00781e68b8a6a8ec8fc7b04f358eefedcd6c3b00`.
Replay base: `7c73f52767d1fd0fb02101cb73c8ae04b7a4f22a`.
Verified source commit: `94b6b3097f202073d8db2ff491411a87ff50be21`.
Verified source tree: `ca39d39305691ca289c968802d3548ebe6715ddb`.
Branch: `codex/timemachine-local-backup-drill-20260917`.
The source is bound by the content hashes below; this evidence does not bind a
remote PR head.

## Source Binding

- Driver SHA-256: `b3b59b52e7ab71fcd559fc2e3f77f52df2246cd62cb7248cb06ff6cb86194c3b`.
- Fixture SHA-256: `83836f224593d6b43191b962b994d9820827815194f3ee1ea9b9dae84382dc95`.
- Safety helper SHA-256: `4552d8fdd8d926bb10eaf3ed291f00ac2d3937d42d89e8f30ba088338d2be68f`.
- Worker SHA-256: `1a45d3d2e615e7476e64207bada132a9dd976cdc278bfb23d75c344911a7746b`.

## Local Evidence

PostgreSQL 15.17 on an explicitly dedicated disposable loopback cluster;
synthetic data only, two independently owned databases. Full source migration,
quiesced custom-format pg_dump, empty-target pg_restore, copied encrypted
objects/custody, preserved receipt/store identity and ten nonce tuples.
The original database and file roots are removed before the target worker.

First complete run: PASS, 5,001 exact restored records, two committed chunks,
5,001 derived effects completed, writer block released. PASS is emitted only
after database/backend/path/worker residue is zero. Independent backend census
after the run returned no matching sessions.

Negative controls: unregistered generation, wrong recovery secret, missing
retained key, wrong store UUID, missing/tampered custody package, missing archive
object. Each checks the expected error and unchanged live rows/job/writer state/
revision and effect counts. No nonce-reader rejection contract is invented.

Source-isolation mutation: retain the source database rather than dropping it.
The driver exits nonzero at the source-unavailable oracle before target worker
execution. Cleanup still owns and removes both databases. Restoring the code
returned the pre-hardening driver to SHA-256 `1ba91c4bf7256e6956c8a461e7d95c203007735ea9f8ee25c5b83683ac8d1a2e`.

Safety unit plus custody neighbors: 3 files, 35/35 passed. Core type-check,
including the acceptance TypeScript configuration: passed. Root recursive
type-check in required Node20 now invokes this specialized configuration.
Diff whitespace check: passed. The final restored-code rerun also passed with
5,001 records, ten nonce sections and 5,001 completed derived effects. Independent
SQL census returned databases=0 and backends=0; the dedicated PostgreSQL server
was stopped and its owned data directory removed. The final hardened run at the
source commit above repeated the same full PASS after current-main replay.

Receipt mutation: neutralizing the production receipt SHA/size comparison made
the existing mismatched-receipt test RED. Production bytes were restored to
`7cb6ecc0be84675e5f227bf26c957235ec644cc3b1f4fc9696b010ba02fff91e`;
the complete custody neighbor suite then passed. The driver additionally rejects
both incorrect receipt SHA and size against the copied package.

Sol full review found no P1 and four P2 items: stale source receipt, post-CREATE
cleanup tracking, cleanup identity, and required type-check wiring. These were
addressed. PostgreSQL fault injection (REVOKE against a missing role) produced
42704 after CREATE and left zero databases. Removing the OID comparison made the
replacement-database unit RED; restoration passed. Terra reviewed these ownership
and CI fixes with 0 P1/P2. This report refresh closes the stale receipt item.
All reviewer sessions are closed. Full remote CI is still pending publication.

## Boundaries

This is same-host backup-set recovery, not another physical machine, NAS,
power-loss, unquiesced capture, customer storage, retention or deployed UAT.
Custody receipts/store identity are preserved out of band. Trust flags and
authority triggers are test-only prerequisites in owned disposable resources.
Product source, production configuration and migration definitions are unchanged.

The prior merged #5837 post-main Plugin run was observed cancelled, not passed;
latest-main snapshot at 7c73f527 had Node18 success and Node20 still running.
Three failures were scheduled Phase 5 Nightly Validation, its with-Regression
variant and External Metrics variant, not this unpublished candidate's CI.
Their operational root causes are not adjudicated by this recovery acceptance.
No new Ready, merge, flag activation, dispatch or deployment was performed.
