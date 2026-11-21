# Measured authorization catalog snapshots

These are losslessly gzipped copies of the PostgreSQL 14.24, 15.19, 16.15 and
17.12 catalog captures from 2026-11-21, after the full migrations at commit
`8b8c5e6de1d6d305d90cb8be374c99b839771be6` (tree `801cc03a`). Each synthetic
database used C collation/ctype and UTF8; PostgreSQL 14 also revoked public
schema CREATE from PUBLIC. Migration and collection both exited successfully.
Only structural metadata was read, in a read-only repeatable-read transaction
with search_path set to pg_catalog, public, pg_temp.

`manifest.json` pins the SHA256 of each decompressed original. Preserve JSON
property order, query section order and row order: the production fence hashes
their JSON serialization. No catalog rows or function bodies were rewritten.

The recorded `inspection` is the old implementation's result, including its
unsupported baseDigest that still contained N78. Tests replay `database` and
`rows` through the current inspector. The independently captured `partitions`
and `digests` describe base, B2 and N78 separately. Removing whole captured
partitions tests historical compatibility; those projections are not separate
live database captures. All four N78 digests are
`ebb4eb31cb35209de3785b867c41c17093032eaf2eccc7ebd3912f56f0b3f515`.

## YiDa stack additions (`stack-additions.json`)

The four captures predate the YiDa stack. Its migrations add D21 (six triggers
on fenced tables, two trigger functions and the `subject_authorization_versions`
table) and the Y6 generated-layout guard function. A database the current fence
supports carries both, so the unit suite replays each capture with these rows
added.

`stack-additions.json` holds exactly those catalog rows and the profile of the
D21 version table. They were read with the production queries on PostgreSQL
14.24 (C collation and ctype, UTF8, public schema CREATE revoked from PUBLIC)
after the full migrations of the stack synced with main `0ae272b52`. Property
order and row order are as returned. The two digests are the constants pinned in
`src/admin/authorization-operation-fence.ts` (`D21_CATALOG_ADDITIONS` and
`YIDA_LAYOUT_CATALOG_ADDITIONS`). The real-database matrix checks the same
constants on PostgreSQL 14 to 17, which is why one measurement serves all four
captures; the rows are not a separate live capture of 15, 16 or 17.
