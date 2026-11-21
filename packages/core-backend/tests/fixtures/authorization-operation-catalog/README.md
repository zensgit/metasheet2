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
