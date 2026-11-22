# Measured M06c routing catalog snapshots

Losslessly gzipped originals from the 2026-11-22 capture on a separate test machine at commit
`1c564dfd5836d395630e54115b97324b86d9b3c0`, based on main
`32aac002a2f771effea450276d51c7d5ec3aa8ae`. PostgreSQL versions were 14.24,
15.19, 16.15 and 17.12. All used C/UTF8, template0 databases, and public schema
CREATE revoked from PUBLIC. All migrations ran with no migration exclusion;
M06c (151000) and M06d (151100) were the final two migrations, in that order.

The four capture files and four run logs of that capture passed SHA256
verification. `manifest.json` pins each
decompressed capture byte for byte. JSON property order, section/row order and
function bodies are unchanged. These are structural catalogs of synthetic
databases, not customer data. Password-related names in DDL are column names.

At capture time, `actualSupported` was false and `withoutRoutingSupported` true
on all four versions. Tests replay the measured database and all eight catalog
sections through the current inspector; saved booleans are historical evidence.
The independent routing digest is
`c7b4ab678e7c9bc25ecd9a24bef2de5e5f4e21af818d18aba573c9cd367f4564`.
Original profiles and the B2 and 07b N78 digests remain unchanged.

Removing the routing partition tests compatibility with pre-M06c history; this
projection is not another live capture. The partition contains one FK, so
deleting that whole FK is indistinguishable from never migrating, as in 07b
errata E-5. Empty is accepted; every nonempty partition must match exactly.
Tests reject renamed/changed/extra constraints and partial composite keys;
missing constraints from base and B2 remain rejected. The 07b partition also
contains one FK and retains its existing empty-partition compatibility.

Rollback: an application without this routing registration fails the fence
with 503 on an M06c-migrated database, even when the policy table is empty.
Deployment must arrange migration rollback before application rollback or
explicitly accept that unavailability. M06d is later than M06c and must be
considered first; M06c down refuses a nonempty policy table. Local replay does
not qualify deployment, rollback, or the pending full PG14-17 database lanes.
