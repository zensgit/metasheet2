# Manual Checkpoint Vector Preparation

Status: local pure identity preparation PASS; checkpoint database admission OPEN.
Parent: `a37b986f4f51ea704c59474dd95a1994e9e44c14`, PR #5849.

## Implemented Boundary

`computeRecoveryArchiveCheckpointVectorHash` accepts exactly nine ordered
`section_checkpoint` identities, unique operation UUIDs and positive decimal
sequence strings. It uses format version 2 and domain
`metasheet2:multitable:recovery-archive:source-vector:v2` with the existing NUL
separator and canonical JSON encoder. It returns frozen snapshots.

The existing bootstrap entry point remains format version 1, bootstrap-only,
with its prior domain, preimage and golden hash unchanged. Admission logic is
shared internally, not broadened at the public v1 boundary. Checkpoint inputs
cannot contain ordinary, restore, bootstrap or snapshot-parent heads.

This identity hash does not bind row counts/content roots, grant authority or
prove database persistence. The forthcoming checkpoint events and snapshot
members must bind canonical section digests. No sealer accepts this new kind
yet. No migration, bootstrap marker, claim guard, runtime caller or flag changes
are included in this checkpoint.

## Verification

- Source-vector plus sealer and bootstrap neighbors: 3 files / 54 tests PASS.
- V1 golden remains `924a8b53b98f0b84f1e55e25ae5848bccd1bbd67ffe6979fa3f558d199556356`.
- V2 golden is `d83bce59176b558f3d18a5775543791b14ce6a2252508d9c40ad6a73029aedf5`.
- V2 tests pin domain/version/preimage/hash, immutable input snapshots, bigint
  precision, all nine identity contributions, exact order/cardinality/key set,
  duplicate rejection and mixed-kind rejection.
- Mutation: bypass v2 head-kind check -> 5 precise negatives RED, 11 tests PASS.
- Mutation: reuse v1 domain for v2 -> domain/golden test RED, 15 tests PASS.
- Restoration -> 54/54 PASS; core typecheck, source ESLint and diff-check PASS.

The tests extend an existing collected backend unit file. Local evidence does
not count as new exact-head remote CI. No database or storage was used this run.

## Next Required Implementation

Forward migration and matching dedicated checkpoint sealer/reservations must
enforce one payload-bound full-section event per checkpoint, genesis presence,
generation ownership, exact nine-member order and immutable retries. Existing
bootstrap-only v1 authority remains unchanged. Real database drift/forgery and
repeat-capture mutation tests are required before any runtime caller is added.
