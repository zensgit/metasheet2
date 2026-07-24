# Attendance Issue #4556 W4C-0 Identity-Proof Amendment

> Status: **PROPOSED**
>
> Date: 2026-07-25
>
> Governing lock:
> `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
> at merged RATIFIED SHA
> `d6ac495b947c0b42ed7bee66d9531fbe25a486ca`.
>
> Scope: W4C-0 identity parsing, derivation, persistence, and advisory-key
> construction only.
>
> Runtime posture: **PAUSED** until this amendment is merged as PROPOSED and
> the owner RATIFYs its exact merged SHA. This amendment authorizes no caller
> cutover, flag enablement, deployment, production access, customer data, or
> issue closure.

## 0. Why this amendment exists

The first W4C-0 implementation attempt exposed a contradiction in the
RATIFIED identity contract before any runtime code was committed.

The governing lock correctly requires:

1. `default` org identity only for an accepted
   `legacy_projection_only` compatibility command;
2. import, integration, and scheduled UUIDv5 identities to use their exact
   namespace and NUL-separated source tuple; and
3. advisory builders to reject an identity from the wrong source contract.

The displayed `AttendanceResultOperationIdentityV1` contains only
`{ kind, orgId, entrypoint, id }`. Once reduced to those scalar strings:

- the accepted org posture is no longer observable;
- a UUIDv5 value does not reveal which namespace or source tuple produced it;
- an import-item UUIDv5 can therefore masquerade as a scheduled UUIDv5; and
- validating only the UUID version is both insufficient for derived IDs and
  unnecessarily restrictive for a direct source whose contract says only
  "canonical UUID".

A non-committed identity helper/test attempt exists in an isolated worktree,
but it has no caller wiring or migration and never entered main. The
process-local hidden-symbol approach considered during its design review was
rejected as durable evidence because it would lose proof after queue or
database serialization. Durable correctness depends on persisted source proof;
after revalidation, a factory may mint an ephemeral in-process witness that
must become invalid when serialized.

## 1. Locked correction

This amendment supersedes only these parts of the governing lock:

- section 4's scalar-only `AttendanceResultOperationIdentityV1` construction;
- section 9's three key-builder and three acquisition-helper input signatures;
- section 4's statement that the three TS constants are the only
  identity-derivation source; and
- the section 12.1 derived-ID persistence gates affected by those contracts.

The canonical scalar UUID/org/date forms, namespace UUID values, UUIDv5 name
bytes, advisory hash formula, two-bit classes, and all unrelated gates remain
unchanged.

W4C-0 adds these closed factories and signatures:

```ts
type AttendanceAcceptedWritePostureV1 =
  | 'legacy_projection_only'
  | 'shadow'
  | 'authoritative'

type CanonicalAttendanceRolloutOrgKeyV1 = Brand<
  string,
  'CanonicalAttendanceRolloutOrgKeyV1'
>

type VerifiedAttendanceOrgIdentityV1 = Opaque<Readonly<{
  orgId: CanonicalAttendanceOrgKeyV1
  acceptedWritePosture: AttendanceAcceptedWritePostureV1
}>>

type VerifiedAttendanceOperationIdentityV1 = Opaque<Readonly<{
  kind: 'batch' | 'item'
  org: VerifiedAttendanceOrgIdentityV1
  entrypoint: AttendanceSourceEntrypointV1
  id: CanonicalAttendanceOperationIdV1
  sourceProof: AttendanceOperationIdentitySourceProofV1
}>>

type VerifiedAttendanceCalculationTargetIdentityV1 = Opaque<Readonly<{
  org: VerifiedAttendanceOrgIdentityV1
  userId: CanonicalAttendanceUserIdV1
  workDate: CanonicalAttendanceWorkDateV1
}>>

createVerifiedAttendanceOrgIdentityV1(input):
  VerifiedAttendanceOrgIdentityV1
parseCanonicalAttendanceRolloutOrgKeyV1(input):
  CanonicalAttendanceRolloutOrgKeyV1
createVerifiedAttendanceOperationIdentityV1(input):
  VerifiedAttendanceOperationIdentityV1
rehydrateVerifiedAttendanceOperationIdentityV1(durableRow):
  VerifiedAttendanceOperationIdentityV1
createVerifiedAttendanceCalculationTargetIdentityV1(input):
  VerifiedAttendanceCalculationTargetIdentityV1

buildAttendanceCalculationRolloutAdvisoryKey(
  org: CanonicalAttendanceRolloutOrgKeyV1,
): bigint
buildAttendanceResultOperationAdvisoryKey(
  identity: VerifiedAttendanceOperationIdentityV1,
): bigint
buildAttendanceCalculationTargetAdvisoryKey(
  identity: VerifiedAttendanceCalculationTargetIdentityV1,
): bigint

acquireAttendanceCalculationRolloutLock(
  trx,
  org: CanonicalAttendanceRolloutOrgKeyV1,
  mode: 'shared' | 'exclusive',
): Promise<void>
acquireAttendanceResultOperationLocks(
  trx,
  identities: readonly VerifiedAttendanceOperationIdentityV1[],
): Promise<void>
acquireAttendanceCalculationTargetLocks(
  trx,
  identities: readonly VerifiedAttendanceCalculationTargetIdentityV1[],
): Promise<void>
```

The factory is the only constructor accepted by
`buildAttendanceResultOperationAdvisoryKey`. It strict-parses the org,
posture, entrypoint, kind, and source tuple; derives or validates the operation
ID; freezes the verified result; and exposes the canonical scalar identity
bytes separately from the proof needed to reconstruct it.

The advisory hash remains byte-for-byte unchanged:

```text
"metasheet2:attendance:result-operation:v1\0" + kind + "\0" + orgId +
"\0" + entrypoint + "\0" + operationId
```

The proof is never part of the lock key. It prevents the wrong bytes from
being admitted to that formula. A verified identity is an in-transaction
opaque witness. Serialization intentionally destroys that witness; a queue,
worker, replay, or DB reader must call the rehydrator against the complete
durable proof before a builder accepts it. Plain objects, JSON clones, spreads,
and prototype lookalikes are rejected.

### 1.1 Closed source matrix

| Source kind | Allowed identity | Factory input | Operation ID rule |
| --- | --- | --- | --- |
| `direct_live_punch` | `live_punch` item | canonical client UUID supplied by the authorized boundary | validate canonical RFC 4122 variant/version syntax; no v4-only rule is invented |
| `direct_request_create` | `request_create` item | canonical client UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_request_pending_edit` | `request_pending_edit` item | canonical client UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_request_decision` | `request_decision` item reached from the authenticated web action | canonical web-action UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_request_cancel` | `request_cancel` item | canonical client UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_manual_edit` | `manual_edit` item | canonical client UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_recompute` | `recompute` item | canonical client UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_import_rollback` | `import_rollback` item | canonical client UUID supplied by the authorized boundary | same direct UUID rule |
| `direct_ops_retirement` | `ops_retirement` item | canonical operator-command UUID supplied by the authorized boundary | same direct UUID rule |
| `verified_delivery` | `request_decision` item only | verified delivery-ledger UUID plus the action represented in the command fingerprint | operation ID equals the canonical ledger UUID |
| `import_batch` | `import_batch` batch only | existing canonical import batch UUID | operation ID equals the canonical batch UUID |
| `import_item` | `import_batch` item only | canonical batch UUID, canonical unsigned ordinal, lowercase SHA-256 semantic fingerprint | factory derives UUIDv5 with `ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1` |
| `integration_batch` | `integration_batch` batch only | existing canonical sync-run UUID | operation ID equals the canonical sync-run UUID |
| `integration_item` | `integration_batch` item only | canonical sync-run UUID, canonical unsigned ordinal, lowercase SHA-256 semantic fingerprint | factory derives UUIDv5 with `ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1` |
| `scheduled` | `scheduled` item only | canonical run UUID, canonical user UUID, canonical work date | factory derives UUIDv5 with `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1` |

Every direct source above is fixed to `kind='item'`. The direct UUID rule
accepts canonical RFC 4122 UUID versions admitted by the section 4 parser; the
governing lock did not require every client UUID to be v4. Derived sources
remain UUIDv5 and cannot use the direct source discriminants.

Every unlisted source-kind/entrypoint/kind combination fails before operation,
source, effect, result, job, or outbox DML. A caller cannot submit a final
derived UUID and assert its source kind.

### 1.2 Org posture proof

Before posture resolution, the lexical rollout-org parser accepts only a
canonical UUID or exact ASCII `default`. Its output is sufficient to derive
and acquire the class-`00` rollout lock without claiming a posture. After that
lock is held, the caller resolves rollout state, normalizes the accepted write
posture, and passes both the same rollout-org key and the posture to the
verified-org factory. The factory rejects a changed org key.

The verified-org factory therefore receives the normalized accepted write
posture only after the section 9 rollout lock is held. This is the closed
three-value write posture above, not the rollout-state enum. Effective rollout
`eligible` is normalized to accepted write posture `shadow` before it enters
the factory.

- UUID org keys are valid for every closed posture.
- Exact ASCII `default` is valid only when the accepted posture is
  `legacy_projection_only`.
- `default` with `shadow` or `authoritative` fails before operation or source
  DML. An effective `eligible` state first normalizes to `shadow` and therefore
  fails identically.

The verified identity carries the accepted posture for in-transaction checks,
but the posture does not alter the advisory key bytes.

### 1.3 Durable reconstruction

Every W4 operation/batch/item reservation persists enough immutable,
closed source-proof data to reconstruct and re-run the factory after a queue
or database round trip:

- closed `identity_source_kind`;
- accepted write posture;
- canonical source root UUID;
- ordinal and semantic fingerprint when applicable;
- user UUID and work date when applicable; and
- canonical operation ID as the derived/validated result.

P07 batch jobs additionally persist one ordered, exact-key identity proof
vector. Each entry contains only:

```text
ordinal
semanticFingerprint
derivedOperationId
commandFingerprint
```

The job also persists item count, ordered item-sequence fingerprint, and item
set fingerprint. On enqueue replay and worker reload, the factory re-derives
every item ID from the job's canonical batch/run root plus each vector entry,
then recomputes the locked sequence identity
`(ordinal, derivedOperationId, commandFingerprint)`, item count, ordered
item-sequence fingerprint, and item-set fingerprint. A missing, extra,
reordered, duplicated, changed, or mismatched item fails before
operation/source DML. Removing `commandFingerprint` or sourcing it from a
mutable payload must fail an independent mutation leg. Legacy null-version
jobs retain a null W4 proof vector and cannot satisfy W4 replay or promotion.

Database constraints require exactly the scalar/vector fields for the selected
source kind and reject partial or extra proof fields. Proof fields and the
operation ID are immutable after insert.

The DB boundary also verifies derived identity equality through one immutable
PostgreSQL UUIDv5 function using `pgcrypto.digest(..., 'sha1')`. The function
accepts a namespace UUID plus canonical ASCII/NUL name bytes; CHECK/deferred
constraints call it for import, integration, and scheduled proof shapes.
This deliberately creates TS and SQL implementations. It supersedes the
governing lock's "only identity-derivation source" wording while retaining the
three exact namespace values as the only accepted namespaces. A mandatory
TS/SQL golden-parity gate covers all three namespaces and rejects namespace,
NUL, tuple-order, endian, version-bit, or variant-bit drift.

No serialized JavaScript symbol, prototype, class instance, or caller-provided
"verified" boolean is evidence.

## 2. Required gates

W4C-0 cannot pass until all of these are independently mutation-proven:

1. `default` accepted under `legacy_projection_only`, rejected under
   `shadow|authoritative`, and rejected when effective `eligible` is normalized
   to `shadow`, including after serialization and DB reload.
2. An import-item UUIDv5 cannot be used as integration or scheduled identity;
   the symmetric cross-source matrix is fully covered.
3. Callers cannot submit a final derived UUID to the factory; changing any
   namespace, NUL separator, tuple order, ordinal, fingerprint, user, or work
   date changes or rejects the derived identity.
4. JSON clone, spread, prototype replacement, and plain-object fabrication of
   a verified identity are rejected by the key builder.
5. Queue/DB reload re-runs the factory from immutable source fields and
   detects operation-ID or proof-field drift before source DML.
6. Exact UUIDv5 and signed-bigint golden outputs pin namespace bytes, tuple
   order, NUL separators, SHA-256 big-endian extraction, and `00|10|11`
   classes.
7. The migration rejects unknown source kinds, illegal scalar/vector field
   combinations, changed proof fields, and derived-ID mismatch through the
   canonical SQL UUIDv5 function. Fresh, upgrade, replay, and down gates remain
   those of W4C-0 section 12.1.
8. The rollout builder/helper accepts only the lexical pre-lock org parser
   output. Operation and target builders/helpers accept only post-lock factory
   output. The post-lock factory binds the same org key to the resolved posture
   and cannot infer a legacy posture from the literal value `default`.

## 3. Decision

| Decision | Option | Recommendation |
| --- | --- | --- |
| `OD-W4C-43` durable identity-source proof | (a) closed verified-identity factory plus persisted reconstruction tuple and exact source matrix; (b) retain scalar-only identity and validate UUID version only; (c) use process-local hidden provenance | **(a)** |

Option `(a)` preserves the already RATIFIED advisory-key bytes while making
their admission proof durable and testable. Option `(b)` cannot distinguish
UUIDv5 namespaces. Option `(c)` fails across queue and database boundaries.

## 4. Execution sequence

1. Merge this document as PROPOSED with no runtime code.
2. Owner RATIFYs the exact merged SHA and chooses `OD-W4C-43`.
3. Discard or rework the frozen experimental implementation against this
   amendment.
4. Implement the identity factory, durable proof fields, constraints,
   advisory builders/helpers, and the complete W4C-0 gates in one fresh branch
   from the then-current main.
5. Independent adversarial review must return zero P1/P2 before W4C-0 is
   armed.
