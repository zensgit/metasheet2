# Time Machine local custody decision proposal

Status: PROPOSED / NOT RATIFIED. No runtime, format, flag, or deployment authorization.

## Current evidence and constraint

The persistent local object provider is published in Draft PR #5744 at
`2de92ac69ed1936abe5428c9f16f4e284b977dbb`. It stores ciphertext, not custody keys.
Its local filesystem tests do not establish NAS or independent-host disaster recovery.

`packages/core-backend/src/multitable/recovery-archive-crypto.ts`,
`RecoveryArchiveKeyCustodyAdapter.deriveDekFingerprint`, requires an opaque,
KMS-attested identity of the actual unwrapped DEK. A local file-backed implementation
must not silently satisfy that interface by relabeling a locally computed value.
Existing format-v1 guarantees and admission remain unchanged pending a ratified
assurance/format compatibility decision.

## Recommended owner decisions

| Decision | Proposed boundary | Current authority |
| --- | --- | --- |
| LC-1 Assurance | Introduce an explicitly identified local-custody tier; do not advertise KMS attestation or protection from a compromised service account/host administrator. | Pending |
| LC-2 Separation | Keep custody material outside the archive root, inaccessible through archive APIs. Separate paths alone are not a separate security principal. | Pending |
| LC-3 Recovery | Require an encrypted offline custody backup and a separately held unlock secret. Neither an archive copy alone nor a database copy alone proves recoverability. | Pending |
| LC-4 Rotation | New captures use the new key version; retained archives preserve access to their original key version. Do not rewrite old bindings or destroy old keys automatically. | Pending |
| LC-5 Unlock | Start locked after installation/recovery. Automatic unlock is a separate decision; do not store an unlock secret beside its encrypted backup. | Pending |
| LC-6 Scope | First acceptance uses synthetic local storage only. NAS admission, retention/capture policy, startup activation and production remain separate gates. | Pending |

Accepting these boundaries is not a cryptographic format design. Before implementation,
specify and review the versioned envelope, authenticated context, backup authentication,
key identifiers and error contract using established cryptographic primitives. In
particular, a KEK rotation must not change DEK identity so that the same DEK could evade
the existing nonce-reuse authority. Do not invent an ad hoc encryption scheme or weaken
format-v1 validation for compatibility.

## Bounded implementation order after ratification

1. Specify explicit assurance admission and compatibility behavior; old callers and
   archives retain their existing contract. No generic fallback from KMS to local mode.
2. Implement the isolated custody module and synthetic tests, without standard-startup
   wiring or actual customer key provisioning. Keep all custody I/O outside DB transactions.
3. Prove backup restoration into a separate empty synthetic environment before adding
   operator-facing readiness. Readiness must distinguish storage, locked/missing custody,
   incompatible assurance, missing catalog, and unverified recovery drill.
4. Integrate startup only in a separately bounded window after the storage, custody,
   catalog and capture prerequisites have passed together. Default remains unavailable.

## Required verification

- New process: retained keys unwrap the original generation and verify its manifest.
- Separate environment: restore a consistent catalog/object/custody backup set and
  recover the original synthetic records, not merely decrypt an isolated byte string.
- Missing/wrong unlock secret, tampered backup, wrong key version or mismatched binding:
  fail closed with fixed errors; no key bytes, paths, secrets or provider causes in logs.
- Rotation: both old and new archives remain readable; missing retired key fails
  explicitly; the same actual DEK cannot acquire a new nonce-registry identity.
- Incomplete backup/publication and interrupted rotation: no false-success readiness
  and no loss of the previously usable key version.
- Transaction guard and cross-binding negatives remain discriminating. Guard-removal
  mutations require the applicable test authorization and must be restored before commit.
- NAS or power-loss claims require their own environment evidence. Local APFS results
  and in-process fault injection are not substitutes.

## Customer-facing boundary

Local storage can support recovery while archive objects, catalog and custody remain
available. A single disk failure can destroy all three if they share that disk. NAS
replication or an offline copy helps only when the recovery set includes custody and
catalog and an actual restore has been verified. Lost keys with no usable backup make
encrypted archives unrecoverable. No storage purchase, mount, secret generation, flag,
dispatch, deployment or production operation is included in this proposal.
