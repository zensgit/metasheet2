# Local Custody and Persistent Archive Integration

Status: LOCAL DEVELOPMENT; not runtime enablement or deployment approval.

## Scope

Integrate the existing persistent POSIX archive provider and explicitly admitted
local-v1 key custody without changing archive format v1 or selecting providers
from untrusted manifest fields. LC-1 through LC-6 are owner-authorized for isolated
development and synthetic recovery only. No customer storage or data is used.

## Topology

- Main base: `c5f25af64336b66210577fdc05a9483c93768d26`.
- Archive source #5744: `a1144d60c2d190e68ec96653df3cbf744142440d`.
- Custody source #5811: `fe9809fab7d75d52a8e1ba65c16fc1e763c9a1af`.
- First true merge: `8e80eb56dae84deadc2d28085907d7b3ad2d015d`.
- Second true merge: `ad1462dec2a9922e3f4b743876b808d8526164bf`.
- Original PR branches remain unchanged. Local integration branch:
  `codex/timemachine-local-restore-20260917`.

The only manual merge resolution was the required-web final invocation. It
retains both parents' selectors; no product conflict was manually resolved.

## Composition Compatibility

The older application admission checked five public KMS-style methods directly.
The local capability deliberately exposes none of those methods. Composition
must resolve its authentic WeakMap-backed operations for shape validation, while
retaining the original opaque capability for downstream guarded crypto calls.
Copied or forged local capabilities remain refused before database resolution.
Legacy adapters retain all five method checks. Resolving the shape must not
unlock custody, perform crypto, or start a worker.

## Recovery Acceptance Stages

1. Persist encrypted archive objects and encrypted custody packages in separate
   private synthetic directories. Rotate custody while retaining old keys.
2. Lock the writer; reopen both providers and explicitly unlock a fresh session.
   Authenticate/read all sections and compare exact record payloads.
3. Reject wrong secret, missing custody package and missing archive object.
4. Remaining: isolated real PostgreSQL catalog/nonce authority, independent
   process startup, preview and actual restore job, exact rows and residue audit.

Stages 1-3 alone do not prove stage 4. The reader fixture uses an in-memory
selected binding and a no-op nonce reservation; it is not a durable catalog or
nonce-allocation acceptance test.

## Real Database and Independent Worker Case

Extend the already-wired restore-jobs real-DB suite with one local-storage case,
preserving all existing KMS fixture cases. Its catalog and frozen restore plan
are synthetic fixtures in a fully migrated disposable PostgreSQL database.
The local case supplies a real custody capability and a transaction-scoped
`meta_recovery_archive_reserve_nonce` sink instead of the fixture defaults.

Archive objects and encrypted custody packages are persisted under separate
private directories. The writer locks after sealing. Child processes receive
only synthetic location/receipt identity and the independently held random
secret over private IPC; they open the real file providers and unlock their own
sessions. In local mode, the parent rejects any child request to proxy object
reads. Existing SIGKILL-after-commit, lease takeover, exactly-once 5,001-row
restore, authority revocation and derived-effect drain assertions remain active.

This is a process-restart recovery acceptance, not a clean-machine installation,
PG backup/import, live archive capture pipeline, customer NAS or production UAT.
The catalog remains in the disposable database throughout the process restart.
Production nonce tombstones remain immutable. Synthetic fixture teardown uses
the suite's existing transaction-local replication-role bypass, deletes only
exact nonce generation IDs and local key IDs captured by this test process,
asserts zero residue, and restores normal enforcement at transaction end.
The dedicated database is additionally dropped after acceptance. No production
retention/rollback API or immutable constraint is changed.

## Preserved Boundaries

No standard-startup local provider selection, flags, dispatch, deployment,
customer NAS access, production access, or hard-deleted-table resurrection.
Local custody is not KMS-equivalent. Host compromise, physical-memory erasure,
power-loss durability and network filesystem behavior are not claimed.
