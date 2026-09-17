# Local backup-set recovery verification

Status: local checkpoint, not published or production acceptance.
Base: `00781e68b8a6a8ec8fc7b04f358eefedcd6c3b00`.
Branch: `codex/timemachine-local-backup-drill-20260917`.
The source is bound by the content hashes below; this evidence does not bind a
remote PR head.

## Source Binding

- Driver SHA-256: `1ba91c4bf7256e6956c8a461e7d95c203007735ea9f8ee25c5b83683ac8d1a2e`.
- Fixture SHA-256: `83836f224593d6b43191b962b994d9820827815194f3ee1ea9b9dae84382dc95`.
- Safety helper SHA-256: `b54a0ef54dbf9242dd20dcdbfb6e62309b9ed0a88b9cad607f914a7d837ab34a`.
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
returns the driver to the exact SHA-256 above.

Safety unit: 5/5 passed. Acceptance TypeScript configuration: passed.
Diff whitespace check: passed. The final restored-code rerun also passed with
5,001 records, ten nonce sections and 5,001 completed derived effects. Independent
SQL census returned databases=0 and backends=0; the dedicated PostgreSQL server
was stopped and its owned data directory removed. Terra high read-only helper
review, including caller ownership tracing, concluded 0 P1/P2; two initial
admission concerns were withdrawn after verifying the call path. This is not a
complete independent review of every driver assertion. Full remote CI and new
Draft PR are not yet run. Receipt/authentication mutation and full driver review
remain publication gates.

## Boundaries

This is same-host backup-set recovery, not another physical machine, NAS,
power-loss, unquiesced capture, customer storage, retention or deployed UAT.
Custody receipts/store identity are preserved out of band. Trust flags and
authority triggers are test-only prerequisites in owned disposable resources.
Product source, production configuration and migration definitions are unchanged.

The prior merged #5837 post-main Plugin run was observed cancelled, not passed;
latest-main verification needs a fresh network read. That observation is not
evidence of a product failure. No new Ready, merge, flag activation, dispatch or
deployment was performed.
