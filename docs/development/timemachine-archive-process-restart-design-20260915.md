# Time Machine Archive Process Restart Acceptance

Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.
Scope: isolated test-only acceptance of the existing encrypted archive worker facade.
No runtime, authorization, provider, flag, migration, or recovery semantics change.

## Contract

The existing 5,001-record test expires an in-process claim. This additional acceptance
must use separate operating-system processes and independently observable database state:

1. Seed a synthetic encrypted archive and accept its durable two-chunk recovery plan.
2. Give a worker process a real PostgreSQL connection and the existing facade. At a
   deterministic barrier either immediately before COMMIT or immediately after COMMIT
   but before returning the result, terminate that process with SIGKILL and observe its exit.
3. Assert PostgreSQL has released the terminated process's connections. Before COMMIT,
   the first record, progress, receipt and revision must remain unchanged. After COMMIT,
   exactly one record, receipt and revision must exist despite the missing acknowledgment.
4. Independently read the persisted lease and compare it with the killed worker's observation;
   assert the lease is live and the canonical selector cannot pick that job prematurely.
   Wait for the database-read deadline. Reclaim with the canonical API; the durable
   block fence stays unchanged while the worker fence increases. The existing in-process
   case proves old branded-claim refusal; process cases prove serialized claim observations
   cannot become write authority, without any additional revision or progress.
5. Run the remaining chunks and finalization in a new process with a different PID.
   All 5,001 records must have exactly one restore revision, committed counts must match,
   the aggregate must contain exactly two chunks, and the writer block must be released.
6. Clean up every child, connection, object directory and database fixture, including
   failure and timeout paths. No readiness signal or missing dependency may count as PASS.

## Fidelity and Boundaries

The child uses the production async facade and real PostgreSQL transactions. The existing
encrypted local test object-store provider keeps metadata in process memory, so the parent
hosts that provider as a long-lived read-only IPC fixture service for both worker processes.
The worker does not regenerate objects or synthesize descriptors from read requests.
This tests worker death, not object-store service death or durable provider metadata.
Synthetic key material crosses only the local
test IPC channel; it is not logged, committed as a secret, or taken from a real provider.
The test policy callbacks remain explicit synthetic allow-all fixtures. This is process
recovery evidence, not production authorization, KMS, independent object-store durability,
server startup composition, staging, or tenant UAT evidence.

The parent owns fixture creation. Each worker selects and claims its own task through the
canonical API; branded in-memory claims are never transferred as authority over IPC.
Workers own chunk execution and finalization. No database replay or archive regeneration occurs between
the failed worker and its replacement. No whole-sheet hard-delete resurrection is added.

## Gates

- Both forced-termination boundaries pass through the existing whole-file real-DB CI lane.
- Mutating the before-COMMIT barrier to run after COMMIT must fail the zero-write oracle.
- Reusing the expired claim for the replacement must fail rather than silently complete.
- Run the complete restore-job real-DB suite and existing archive wiring checks.
- Verify final fixture/backends/process residue, typecheck, diff-check and exact-SHA review.
- Publish design and verification evidence with a Draft/HOLD PR; remote CI remains separate.
