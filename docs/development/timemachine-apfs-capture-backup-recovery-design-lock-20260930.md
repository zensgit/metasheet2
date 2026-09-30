# Time Machine APFS capture-to-backup recovery design lock

Status: LOCAL SYNTHETIC DEVELOPMENT. This lock does not authorize staging deployment, customer data, or flag activation.

## Why this slice exists

Current acceptance proves two different chains: the manual HTTP/browser driver captures and restores a real generation in one database, while the local backup driver imports a seeded generation into a second database and restores 5,001 rows after removing its source. Neither proves that a generation returned by the public manual-capture route survives a quiesced database-and-file backup as the **same** generation and restores from an empty target. Keep both existing results and their limits.

The local APFS proof must use one synthetic generation from capture through target restore. It may reuse the owned two-database backup driver and the manual-capture driver, but must not seed a replacement verified catalog row after import or silently substitute the existing seeded archive fixture. No product route, format, migration, privilege, retention policy, or default flag changes are in scope.

The two drivers cannot be joined by swapping only a generation ID. The backup fixture also pre-accepts a 5,001-row async restore plan; the manual attachment HTTP case uses a separate in-memory synthetic custody adapter. The new path must capture with authentic local custody, import that catalog and object set, and build its restore plan against the imported target after the target edit. Keep the existing 5,001-row and browser checks as separate regression controls; they do not silently become evidence for this path.

## Acceptance chain

1. On an exclusively owned disposable loopback PostgreSQL cluster, create an owned synthetic source database and an empty owned target. Admit private APFS archive and custody roots. Reject any default/shared `DATABASE_URL`, production port, wrong database owner, pre-existing target tables, or overlapping roots before IO.
2. Seed only synthetic fixture rows and a content-addressed attachment on the owned source. Through the real manual HTTP route and canonical authority, capture one generation containing that scalar record and immutable attachment. Retain the returned generation ID and source binding, exact expected record data and attachment bytes, store UUID, custody receipt, and nonce section roster outside the restore process. An exact retry must return the same generation.
3. Quiesce HTTP writers and workers. Dump the source database and copy its immutable archive objects plus encrypted custody package as one backup set. Keep the recovery secret only in private memory/IPC. The source generation must already be verified before the dump; the backup process may not synthesize a catalog row.
4. Import into the empty target and copy files to distinct private roots, preserving object IDs/versions, store UUID, custody receipt, and nonce tuples. Remove the owned source database and source roots before any target restore. The official local launcher in a fresh target process must remain listener-free until FD3 operator unlock from the copied custody package; it may not read the source or proxy object reads to its parent.
5. The target public catalog/preview must select the captured generation ID. Under exclusive ownership of the disposable target database, make a test-only SQL edit to the synthetic scalar and attachment reference; then execute restore through the official launcher's authenticated public HTTP route. This proves backup portability and the restore path, while ordinary record-writer behavior remains covered by its existing tests. Assert exact captured scalar data and attachment bytes, expected version/history effect, graceful stop with no listener, and no unexpected second generation on this sheet. The source ID, imported ID, preview ID, and restored ID must match exactly. Run the existing preaccepted 5,001-row worker proof and its negatives before the official launcher, so its eager worker cannot change their baseline; keep writer-block release and derived-effect drain as a separate control.
6. Stop all children, close clients, remove only resources owned by this run, and independently assert zero matching database, backend, path, and process residue. Emit values-free evidence bound to the exact source commit/tree and test-tool hashes.

## Required refusal controls

- Wrong recovery secret, wrong store identity, and missing/tampered custody package refuse under the existing two-database controls. A missing object from the HTTP-captured attachment generation must refuse before target live writes. The target row signature must remain unchanged.
- A foreign or newly registered generation must not stand in for the HTTP-returned generation. Source and target selected bindings and the single generation on the synthetic sheet must match. The source database and file roots must be unavailable before target restore.
- Existing driver negatives and product authorization tests remain in force; this synthetic local drill does not grant a new authorization bypass. Mutation checks must restore original bytes and rerun the positive path.

## Evidence and release boundary

The result is **same-host, quiesced, synthetic APFS portability** only. It does not prove remote staging storage/KMS, independent physical-host durability, hot backup, power-loss recovery, real tenant fidelity, production capture policy, NAS behavior, or customer UAT. Existing Phase 5 nightly missing latency samples are a separate open operational gate; no threshold relaxation or production sample-generating operation is part of this slice.

Before any staging deployment, freeze the exact candidate/build SHA; review required CI, flag-off parity, deployment environment, synthetic-data ownership, rollback and residue steps; then obtain the separate owner staging authorization required by the O-2 ladder and D7 runbook. A PASS from this local slice is not that authorization.

Delivery is a focused test-only implementation and exact-SHA verification report in one PR. The existing large manual driver must not absorb a second backup implementation; extract the minimum reusable capture step or use a small sibling module. A report without the executing code and real two-database run is not a completion claim.
