# Local backup-set recovery acceptance

Status: LOCAL IMPLEMENTATION under the existing LC-1..6 synthetic acceptance
authorization. Not a production backup API, startup activation or deployment.
Exact starting main: `00781e68b8a6a8ec8fc7b04f358eefedcd6c3b00` (PR #5837).

## Missing proof

The existing local-storage restore-jobs case reopens file providers in another
process but retains the same PostgreSQL catalog. The real HTTP/browser script
also seeds a catalog. Neither establishes restoration from a consistent backup
set into an empty database. Preserve these successful tests and their claims.

## Bounded implementation

Implement a test-only acceptance driver using the existing durable archive,
verified-catalog, frozen-plan and process-worker helpers. No product source,
format, privileges, flags, migrations or customer-facing backup API changes.
Never dump an arbitrary DATABASE_URL or the shared CI database. The driver must
create and own a uniquely named synthetic source database and a separate empty
target database on an explicitly admitted disposable loopback PostgreSQL server.
Database names, local roots and cleanup ownership must be validated before IO.

1. Apply the current full migration stream to the owned source; create only
   synthetic records, genuine local custody, persistent encrypted objects and
   real nonce reservations. Retain the original source identity and expected
   record payloads outside the restore process as the oracle.
2. Quiesce all source writers/workers before taking the database dump and copying
   immutable archive objects plus custody packages. Preserve the store UUID
   marker, object IDs/versions and exact custody receipt. Do not re-provision a
   different store identity or rebuild catalog rows on the destination.
3. Import the dump into the empty owned target, copy files to new private roots,
   and construct fresh providers. Recovery secret remains separately held and
   crosses only private IPC; it must not be in dump metadata, command arguments,
   evidence, plaintext files or logs.
4. Make original source resources unavailable to the restore worker. A successful
   restore must not consult the source database, original object paths, parent
   object RPC or a still-unlocked source custody session. Prove target database
   identity and different filesystem roots, not merely a different process PID.
5. Execute existing restore-job operations against the imported catalog and
   copied objects. Assert exact original synthetic rows, versions, single restore
   effects, terminal job state, writer-block release and derived-effect drain.
6. Clean only databases/directories created by this run, close all clients and
   workers, and independently assert zero database/backend/fixture residue.

## Fail-closed evidence

Before the positive control, an unregistered catalog generation, missing object, missing/tampered
custody package and wrong secret must refuse without changing target live rows.
Retained pre-rotation keys must remain usable; same-name wrong store identity
must refuse. Assertions must cover the actual expected failure boundary, not
accept any thrown error. A mutation retaining source access must be caught by
the source-isolation oracle; removing a receipt/authentication check must turn
the corresponding negative red. Restore all mutated bytes before final gates.

## Scope of the result

The custody receipt and store UUID are out-of-band recovery inputs today; they
must be preserved explicitly, not assumed to be available from the SQL catalog.
Compare imported nonce tuples exactly with the source and with the canonical
section list (currently ten, including coverage_index). Reading does not consult
the nonce table, so deleting a nonce row is not claimed to be a reader rejection
contract. Distinct roots need distinct canonical paths/inodes, not different
physical devices for this same-host drill. No mount/root-identity mutation is
authorized or necessary.

Two disposable databases and new private roots on one host prove separate local
environment recovery, not independent physical-host, NAS, power-loss, continuous
capture, unquiesced backup consistency, retention policy or disaster-site UAT.
Those remain explicitly separate. Do not label this clean-machine production
recovery. Existing standard startup remains locked/unconfigured.

The owned source fixture enables the canonical recovery-authority triggers and
the test processes set recovery trust flags only in their private environments.
The dump preserves that synthetic prerequisite. No service environment or
deployed database is changed. A default migrated database with those triggers
disabled is not represented as recovery-ready.

## Delivery gates

Focused driver/ownership tests; real source dump and empty-target import; genuine
record recovery and negatives; discriminating mutations; independent bounded
review; cleanup census; exact-SHA verification report. Publish only a Draft/HOLD
candidate after these gates, with any local-only versus CI scope stated exactly.
