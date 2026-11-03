# Local backup-set recovery verification

Status: published Draft #5847; local verification, not production acceptance.
Base: `00781e68b8a6a8ec8fc7b04f358eefedcd6c3b00`.
Replay base: `d944a1276a65b01a33701486b31b7b3eddf588ae`.
Verified source commit: `e814ae7e19ddb7d4242913c2fd3732dd4c880ae8`.
Verified source tree: `4630fe5b68fd9a3d18405a8f604dafc33c703bfa`.
Branch: `codex/timemachine-local-backup-drill-20260917`.
The source is bound by the content hashes below; this evidence does not bind a
remote PR head.

## Source Binding

- Driver SHA-256: `65467ad267460c201e7cc701485bee8af3efa9bed09832a9b3977dc72e820026`.
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
All reviewer sessions are closed. These review verdicts precede the facade
fix-forward below and are not a fresh review of it.

## Exact-Head CI Fix-Forward

Published head `5ac384d8e39f740c54a52311dbe31a649cdb4505` failed both
Node18 and Node20 in run `35174540463`. Both logs identify the same sole failed
test: the archive reconstructor's public-consumer authority census. The drill
called the internal decrypt-only reader from a script, violating that boundary.

Commit `063f8fc40eb6b220fe82cc74d18c3a97fd2e5574` switches all drill reads
to `readRecoveryArchiveCompleteSectionState`, supplying the owned target query
and asserting the returned complete state. The census and production modules
are unchanged; the fix does not whitelist a bypass. Both wrong-key and missing
object negatives still assert their original fixed error codes.

On that source, the full isolated PostgreSQL backup-set run passed again:
5,001 records, ten nonce sections, two chunks, 5,001 drained effects, source
unavailable before the worker, writer block released. Independent SQL census
returned database=0/backend=0; the dedicated cluster was stopped and removed.

The following true merge of main `d944a1276a65b01a33701486b31b7b3eddf588ae`
was conflict-free. Driver, recovery production modules, migrations and fixture
utilities are byte-identical to the real-DB-tested commit. Post-replay focused
reconstructor/safety/custody tests: 4 files, 51/51 PASS. Core type-check,
including acceptance config: PASS. New remote exact-head CI remains pending;
the old failing head must not be reported green.

## Boundaries

This is same-host backup-set recovery, not another physical machine, NAS,
power-loss, unquiesced capture, customer storage, retention or deployed UAT.
Custody receipts/store identity are preserved out of band. Trust flags and
authority triggers are test-only prerequisites in owned disposable resources.
Product source, production configuration and migration definitions are unchanged.

The prior merged #5837 post-main Plugin run was observed cancelled, not passed;
latest-main snapshot at 7c73f527 had Node18 success and Node20 still running.
Three failures were scheduled Phase 5 Nightly Validation, its with-Regression
variant and External Metrics variant, distinct from this candidate's CI.
Their operational root causes are not adjudicated by this recovery acceptance.
No new Ready, merge, flag activation, dispatch or deployment was performed.
