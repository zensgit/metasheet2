# Stock-preparation sealed-export manifest capability spike

**Date:** 2026-07-27
**Status:** **PROPOSED / SPIKE ONLY**
**Issue:** [#4633](https://github.com/zensgit/metasheet2/issues/4633)
**Source baseline:** `origin/main` at `e4509ab71e6061e7d1188d24f9b30f09fb71c435`
**Issue snapshot checked:** 2026-07-27, issue open, no implementation authorization

This document is an owner-decision-grade capability comparison. It does not
authorize implementation, runtime wiring, a concrete profile certification,
deployment, flag enablement, an external write, or rollout. The existing
bounded approved-config route may still complete #4628 independently if a
genuinely bounded source is found.

## 1. Decision

### 1.1 Recommendation

For the current `bridge:legacy-sql-readonly` class:

- **Conditionally prefer `SEALED_EXPORT_MANIFEST`** as the first unbounded-source
  hardening path.
- **Do not build an interactive cursor path** unless a capability spike first
  proves a source-native durable snapshot identity that remains valid across
  requests and reconnects.
- A cursor, offset, keyset, `done=true`, row count, or long-lived connection is
  not by itself a durable snapshot proof.
- If an adapter must materialize rows locally to make a cursor durable, it has
  implemented an export cache in substance. In that case the explicit sealed
  export contract is simpler to reason about and audit.

This is capability-based, not database-brand-based:

1. A source with a native durable snapshot token plus a stable cursor may prefer
   a cursor-capable adapter.
2. A source without that token, but with a connector-owned one-pass capture that
   can be frozen, signed, and uploaded, should prefer sealed export.
3. A source with neither capability remains bounded-read-only and must fail
   closed for an unbounded run.

### 1.2 What this recommendation does not prove

The recommendation does not certify the consistency of a future export. A
signed manifest proves who attested to a frozen artifact and whether the bytes
arrived unchanged. It does not retroactively make the source query a
point-in-time snapshot. The concrete read-action profile must separately prove
the capture semantics used by its named export action.

For SQL Server, for example, a random export identifier is not a snapshot
identity. The profile must demonstrate one of the consistency mechanisms
allowed by the GIP/scale contracts. If the real engine cannot provide the
claimed semantics, certification is refused.

## 2. Evidence baseline

All source references below are bound to
`e4509ab71e6061e7d1188d24f9b30f09fb71c435`. References use file plus symbol or
document section, not a drifting line number.

| Evidence | Exact source |
|---|---|
| The legacy bridge exposes only health, object, schema, and single query endpoints. Its query body is `limit` plus equality filters; it returns `nextCursor = null` and `done = true`. | `scripts/ops/bridge-agent-readonly.ps1::{Invoke-BridgeRequest, New-ObjectQuerySql, Invoke-BridgeSqlQuery}` |
| The agent query uses `SELECT TOP`, executes one SQL command, and accumulates the whole result in memory. There is no export file, manifest, signing key, chunk upload, or durable cursor protocol. | `scripts/ops/bridge-agent-readonly.ps1::{New-ObjectQuerySql, Invoke-BridgeSqlQuery}` |
| The server adapter verifies the agent-echoed applied limit, but still exposes one JSON read with no continuation. | `plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs::{createBridgeAgentReadonlyAdapter/read, BRIDGE_READONLY_ADAPTER_IMPLEMENTATION_VERSION}` |
| The current concrete profile honestly certifies only one bounded request, an empty consistency-proof set, `SHORT_PAGE`, and `SINGLE_REQUEST`. | `plugins/plugin-integration-core/lib/gip-bridge-bounded-read-profile.cjs::{BRIDGE_BOUNDED_READ_PROFILE, adjudicateBoundedReadCompleteness}` |
| The stock-preparation feeder accepts only `short_page` or `declared_total`; a full page without a usable continuation fails closed. `done=true` is explicitly not evidence. | `plugins/plugin-integration-core/lib/stock-preparation-readonly-source-run.cjs::{SOURCE_KIND_CAPABILITIES, readAllMappedRows, effectivePageSize, assertKnownSourceComplete}` |
| The generic SQL read adapter's current cursor is either an offset or an in-run watermark/keyset value. It carries no source snapshot identity and does not span calls with one transaction. | `plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs::{parseOffsetCursor, buildWatermarkReadPlan, createDataSourceSqlReadonlySourceAdapter/read}` |
| GIP already freezes `SEALED_EXPORT`, `IMMUTABLE_SNAPSHOT_TOKEN`, `DURABLE_TOKEN`, `SIGNED_MANIFEST`, `CHUNK_RESUME`, and successful-run completeness evidence rules, but the module is latent. | `plugins/plugin-integration-core/lib/gip-profile-certification-contracts.cjs::{assertCertificateCrossDimensionLegal, normalizeCertifiedReadActionProfile, deriveRecoveryStrategy, validateCompletenessEvidence}` |
| The large-BOM worker seals one in-memory artifact, then checkpoint chunks write directly to the target under a process-local lock. | `plugins/plugin-integration-core/lib/stock-preparation-large-bom-jobs.cjs::{updateJobFromExpansion, runLargeBomCheckpointApplyJobChunk, activeCheckpointApplyRuns}` |
| The large-BOM test demonstrates a paused checkpoint job already has target rows, so it is not an invisible generation model. | `plugins/plugin-integration-core/__tests__/stock-preparation-large-bom-jobs.test.cjs::{testCheckpointApplyChunksPlanAndKeepsPublicEvidenceValuesFree}` |
| The plugin durable store is JSON `get/set/consume/delete/list`; `set()` is an upsert and exposes no lease or CAS primitive. | `packages/core-backend/src/plugins/plugin-durable-storage.ts::{createPluginDurableStorage}` |
| Scale D0 defines private staging, sealed artifact, checkpointed apply, generation isolation, and final CAS visibility, while explicitly recording that the scale kernel itself remains proposed. | `docs/development/general-prep-scale-sync-kernel-d0-design-lock-20260723.md::{sections 2, 3, 4, 5, 6.3, 8, 9}` |
| GIP D0 ratified only the generic profile schema, compliance harness, and read-only qualification spike. A concrete sealed profile and runtime remain separately gated. | `docs/development/gip-d0-general-integration-platform-design-lock-20260723.md::{sections 3, 5, 9, 10}` |

## 3. Existing substrate: reusable parts and hard gaps

### 3.1 Legacy bridge

Reusable:

- localhost-only, read-only, allowlisted named objects;
- equality-only filters and no raw SQL request surface;
- applied-limit echo verification;
- redacted errors and a connector-owned implementation version;
- one connector-owned SQL command per read.

Missing for sealed export:

- a connector-owned named export action;
- streaming from `SqlDataReader` to a private local artifact instead of
  accumulating an array;
- a source capture identity with certified semantics;
- a cross-language canonical manifest format;
- per-system signing keys and server-side key pinning;
- chunking, resumable upload, receipt persistence, retention, and cleanup.

The current shared-secret HTTP header is request authentication. It must not be
reused as a manifest signing key.

### 3.2 Source-run completeness gate

The current gate is correct for its declared inputs and must not be weakened.
`readAllMappedRows()`:

- follows only a continuation the certified source actually offers;
- rejects an unknown applied page size;
- rejects a repeated page or cursor loop;
- accepts only `short_page` or `declared_total`;
- rejects a full terminal page as
  `SOURCE_RUN_COMPLETENESS_UNPROVABLE`.

A sealed-export path must enter through a separately certified proof consumer.
It must not teach this bounded feeder to trust `done=true`, raise page budgets,
or reinterpret a full page as complete.

### 3.3 Large-BOM job substrate

The current large-BOM implementation contains useful contract shapes:

- durable-store-required posture;
- queued/running/paused/failed/completed status vocabularies;
- private job state plus a values-free public projection;
- an authoritative artifact gate;
- checkpoint counters and explicit chunk execution;
- permission and approval checks.

It is not the required scale runtime:

- `runLargeBomBackgroundExpansionJob()` calls the expansion once and
  `updateJobFromExpansion()` places all rows in one `job.artifact`;
- `runLargeBomCheckpointApplyJobChunk()` calls
  `applyStockPreparationPlan()` against the live target for each chunk;
- `testCheckpointApplyChunksPlanAndKeepsPublicEvidenceValuesFree()` proves a
  paused job already has target rows, so partial work is visible;
- concurrency protection is the process-local
  `activeCheckpointApplyRuns` set;
- `createPluginDurableStorage()` provides `get/set/consume/delete/list`, and
  `set()` is an upsert with no compare-and-swap or lease.

Therefore:

- reuse the status, scope, evidence, budget, and checkpoint **contract shapes**;
- do not store a large export's business rows inside one `plugin_kv` JSON value;
- do not reuse direct-to-live-target checkpoint apply;
- build DB-backed lease/CAS, private staging, generation isolation, and final
  visibility flip as separately authorized scale slices.

## 4. Capability comparison

| Dimension | `SEALED_EXPORT_MANIFEST` | Durable-snapshot cursor adapter |
|---|---|---|
| Required source capability | One connector-owned capture that can run to completion under certified source semantics | Native snapshot identity that survives requests/reconnects, plus a stable continuation cursor |
| Source-side change | No interactive paging requirement, but the named capture may require snapshot/RCSI/temporal support or another certified consistency mechanism | May require native snapshot/session APIs, stable unique ordering, token retention, and source configuration |
| Current legacy bridge fit | Leading candidate; requires a new agent export protocol | No current fit; the agent exposes neither cursor nor durable snapshot |
| Consistency proof | Frozen artifact plus the concrete profile's certified capture semantics | Source-native durable snapshot token; cursor must remain bound to it |
| Completeness proof | Signed manifest, ordered complete chunk set, row count, whole-artifact digest | Terminal short page or declared total under the same durable snapshot |
| Resume | Resume upload of already frozen chunks; never re-read the source | Resume page read using the same still-valid snapshot token |
| Failure after source disconnect | Artifact remains resumable | Only resumable if the snapshot token remains valid; otherwise whole round restarts |
| Source load | One full export read | Repeated page reads, unless the source internally materializes a snapshot |
| Local agent storage | Required until server seal acknowledgment and retention cleanup | Optional only when the source owns a durable snapshot; otherwise local materialization is required |
| Server storage | Private upload/blob staging plus parsed generation staging | Page staging plus generation staging |
| Protocol complexity | Export request, manifest signing, chunks, receipts, cleanup | Snapshot acquisition, cursor binding/MAC, lease/TTL, page protocol, cleanup |
| Deployment change | New complete agent/service package, per-system key enrollment, server private-ingestion storage, and controlled deployment | New adapter/agent session implementation, possible database capability/config change, token store, and controlled deployment |
| Drift risk | No cross-request source drift after capture; capture semantics still require proof | Low only with a real durable snapshot; keyset alone does not prevent drift |
| Operational pressure | Disk, upload bandwidth, key lifecycle, retention | Snapshot retention, source transaction/session pressure, cursor expiry |
| Best fit | Bridge, file, non-paginatable, or agent-local sources | Sources with native temporal/database snapshot APIs and stable cursor semantics |

### 4.1 Decision rule

The preflight decision is:

```text
if nativeDurableSnapshotIdentity
   and stableCursorBoundToSnapshot
   and reconnectResumeProven:
  durable-snapshot cursor is eligible
else if connectorOwnedOnePassCapture
        and captureConsistencyProven
        and privateArtifactStorageAvailable
        and signerLifecycleAvailable:
  sealed export is eligible
else:
  unbounded mode is unavailable
```

No branch silently downgrades or upgrades. A customer who needs bounded
semantics continues to use a separately certified bounded profile.

## 5. Candidate sealed-export certificate coordinates

The candidate profile name is `bridge.sealed_snapshot.v1`. The following is
only its capability-coordinate excerpt, not a complete
`normalizeCertifiedReadActionProfile()` input. A concrete profile still needs a
certified `connectorKind`, named `actionId`, and implementation version:

```yaml
certificateCoordinate:
  acquisitionMode: SEALED_EXPORT
  supportedConsistencyProofs:
    - IMMUTABLE_SNAPSHOT_TOKEN
  continuationLifetime: DURABLE_TOKEN
  supportedCompletenessProofs:
    - SIGNED_MANIFEST
  completenessCombinationRules:
    - [SIGNED_MANIFEST]
```

`deriveRecoveryStrategy()` maps this certificate payload to `CHUNK_RESUME`.
The apply dimension is separate and would require an independently certified
`STAGED_GENERATION` apply profile.

In this candidate, `IMMUTABLE_SNAPSHOT_TOKEN` describes the sealed artifact
after capture. It is **not** sufficient evidence that the source rows came from
one point in time. Before certification, S0 must freeze how capture-time
consistency is represented:

- if the scenario requires point-in-time source consistency, the concrete
  profile must additionally certify and use `SOURCE_SNAPSHOT_TXN` (or another
  independently ratified source-time mechanism); or
- if the scenario does not require it, run evidence must explicitly record the
  consistency requirement as `NOT_REQUIRED`.

The signer, manifest digest, export ID, or completion timestamp must never be
relabeled as a source snapshot proof.

The candidate is invalid unless the concrete certification gate proves:

- the named action cannot accept raw SQL;
- the approved binding selects the action, object, filters, mapping, and
  canonical contract;
- the source capture identity has the claimed semantics;
- the agent signs only after the source reader completed, artifact bytes were
  finalized, and the unsigned manifest payload was frozen;
- no truncated or failed capture can receive a valid signature.

## 6. Manifest contract

### 6.0 Trust boundary

The v1 threat model is:

- first-party connector/agent code, the server verifier, and the server key
  registry are trusted code;
- source rows/schema, transport, retries, chunk order, stale manifests, and
  caller-supplied values are untrusted;
- a signature proves possession of the pinned agent key and binding of the
  frozen bytes. It does not prove that the source database is truthful;
- compromise of the agent host can misuse its private key. Detection,
  revocation, quarantine, and re-enrollment are the response; the manifest
  protocol cannot turn a compromised signer into a trustworthy one;
- a future third-party connector is outside this profile and requires a
  separate sandbox/process-isolation design gate.

### 6.1 Two bound objects

The flow needs two immutable objects:

1. **Export request envelope**, issued and authenticated by the server:
   - one-time `exportRequestId` and nonce;
   - expiry;
   - `scenarioVersion`, `bindingVersion`, and semantic `roleId`;
   - `actionProfileVersion`;
   - `roleBindingFingerprint`;
   - `systemContentKey`;
   - `approvedConfigVersionId` and `configContentKey`;
   - `canonicalObjectVersion`;
   - `qualificationDigest`;
   - `executionMode` and `applyProfileVersion`;
   - canonical query/object/filter binding digest;
   - expected source schema/field-map digest;
   - tenant-domain binding;
   - row/byte/chunk budgets.
2. **Signed manifest**, produced by the agent:
   - exact digest of the export request envelope;
   - source capture identity and proof class;
   - agent implementation/protocol version;
   - encoding and canonicalization version;
   - source schema digest;
   - total rows and bytes;
   - ordered chunk descriptors;
   - whole-artifact byte digest;
   - canonical rowset/multiplicity digest;
   - capture completion timestamp and manifest expiry;
   - signer `keyId`, algorithm, and signature.

The agent must not receive or execute raw SQL from this envelope. It resolves a
first-party named action and an allowlisted object through connector-owned code.
The request-authentication mechanism is directionally separate from the
agent's manifest-signing key. The current bridge request secret may authenticate
the request channel, but it must not be reused as the manifest signing key.

Before issuing the envelope, the server must locally verify that the binding
version is still active, the approved config and system identities still match,
and the qualification envelope is authentic and unexpired. Before the final
visibility CAS, the server repeats the same local verification in the
activation transaction; it performs no external probe there. A revoked,
superseded, expired, or mismatched binding/qualification quarantines the
unactivated generation.

### 6.2 Required binding

The signed bytes bind all of:

```text
query/filter identity
+ canonical object and schema contract
+ scenarioVersion, bindingVersion, and roleId
+ roleBindingFingerprint and actionProfileVersion
+ systemContentKey
+ approvedConfigVersionId and configContentKey
+ canonicalObjectVersion and qualificationDigest
+ executionMode and applyProfileVersion
+ source snapshot identity
+ export request nonce
+ ordered chunk identities and digests
+ row count and byte count
+ whole artifact digest
+ signer identity and manifest expiry
```

Changing any one term produces a different signed payload.

### 6.3 Canonicalization and digests

- The signature covers a versioned cross-language canonical byte form, not
  PowerShell's default JSON serialization and not JavaScript property order.
- A candidate is RFC 8785/JCS-compatible UTF-8 JSON, but the implementation
  gate must choose and freeze one codec with shared golden vectors.
- Every chunk digest covers the exact uploaded bytes.
- The whole-artifact byte digest covers chunks in manifest order.
- The server independently parses the artifact and recomputes row count plus a
  multiset-aware canonical row digest. Duplicate rows remain duplicate; no
  `EXCEPT`-style deduplication is allowed.
- Raw content digests stay private. Public evidence uses a tenant/system-domain
  isolated digest or HMAC projection so cross-tenant equality is not an
  existence side channel.

### 6.4 Chunk resume

- The manifest is finalized before the first upload.
- The server atomically consumes the one-time export request nonce while
  creating the upload session. A database uniqueness constraint permits one
  session for one `(tenant domain, system binding, exportRequestId)`.
- An upload session is keyed by the immutable manifest digest. A second
  concurrent start has exactly one winner; the loser may attach only as a
  resume of that same session.
- One manifest digest may create exactly one `generationId` inside its tenant
  and system domain. It cannot be replayed into a second generation.
- A receipt is `(manifestDigest, chunkIndex, chunkDigest, byteCount,
  acceptedAt)`.
- A new chunk must be the next unaccepted manifest index.
- Re-sending an already accepted identical tuple is an idempotent replay and
  does not increment counts.
- Re-sending an accepted index with different bytes is a conflicting duplicate
  and fails closed.
- Skipping or reordering a new index fails closed.
- Resume asks only for accepted receipt indexes. It never reopens the source
  query.
- The source artifact is retained until server seal acknowledgment, then
  removed according to the private retention policy.
- Cleanup retains a values-free replay tombstone through at least the manifest
  expiry and audit-retention horizon. Once the manifest is expired, expiry
  validation still fails before session creation even if private chunk bytes
  have already been deleted.

## 7. Signing-key lifecycle

The manifest uses a per-system asymmetric signing identity:

1. **Enrollment**
   - The agent generates a key pair on its host.
   - The private key is non-exportable where the platform permits and never
     ships inside the application package.
   - An authenticated admin flow performs proof of possession.
   - The server pins the public key to the exact system binding and assigns a
     `keyId`.
2. **Use**
   - The profile pins the allowed signature algorithm and key constraints.
   - Only an `ACTIVE` key may sign a new manifest.
   - The server verifies system binding, key state, expiry, signature, and
     request nonce before accepting any chunk, before sealing, and again in the
     final activation transaction.
3. **Rotation**
   - A new key is enrolled before use.
   - A bounded overlap allows an already-started upload to finish with its
     original manifest key.
   - New exports use only the new active key.
4. **Revocation**
   - A revoked key cannot start, resume, seal, apply, or activate an unsealed
     ingestion.
   - Revocation atomically marks every generation signed by that key that has
     not reached `ACTIVE` as `QUARANTINED`; its active pointer remains
     unchanged.
   - Previously accepted run evidence records the key identity projection and
     remains immutable; it is not silently rewritten.
   - An already active generation enters the separate incident-response path;
     the system does not silently rewrite history or choose a replacement.
5. **Expiry and cleanup**
   - Expired manifests and upload sessions cannot resume.
   - Key status, manifest status, retention deletion, and cleanup outcomes are
     auditable.

Credentials, private keys, shared secrets, raw public keys, source endpoints,
and raw identity material never enter public evidence or errors.

## 8. Private staging and visibility

The minimum safe state machine is:

```text
REQUESTED
  -> CAPTURING
  -> MANIFEST_VERIFIED
  -> UPLOADING
  -> UPLOAD_COMPLETE
  -> STAGING
  -> SEALED
  -> APPLYING
  -> VERIFIED
  -> ACTIVE

any pre-ACTIVE state -- signer/binding/qualification revocation or expiry -->
  QUARANTINED
```

Any failure before `ACTIVE` leaves the previous active generation unchanged.

Required invariants:

- Artifact bytes, manifest, parsed rows, receipts, and generations are private
  tenant-scoped business data.
- A `generationId` is created before parsing/apply and is never reused across
  manifests.
- Persist/diff readers cannot see an unsealed generation.
- Downstream readers select only through `activeGenerationId`.
- Apply chunks write only the inactive generation.
- Before activation, the server compares actual applied row count, canonical
  multiset digest, identity/multiplicity, and complete receipt set with the
  sealed artifact.
- Activation is one short DB transaction: revalidate signer, binding, and
  qualification state; compare-and-swap the active pointer; and write the
  immutable run/audit terminal record.
- Two concurrent activations have exactly one winner.
- Failed generations remain invisible and are retried or retention-cleaned.

The current `plugin_kv` store and process-local large-BOM lock cannot implement
these invariants. New DB schema, lease/CAS, and generation-aware query paths
would require their own design and implementation authorization.

## 9. Evidence boundary

### 9.1 Public values-free evidence may contain

- profile and proof-class tokens;
- success/failure status and closed reason;
- row, byte, and chunk counts;
- duration and retry counts;
- manifest/signing-key presence booleans;
- domain-isolated manifest, artifact, schema, and generation digests;
- signer lifecycle state token;
- `externalWrite=false`;
- cleanup and active-pointer outcome tokens.

### 9.2 Public evidence must not contain

- rows or field values;
- object, table, column, endpoint, host, path, or credential identifiers;
- raw filters, query text, raw config, or raw manifest;
- private artifact references;
- snapshot tokens, cursors, nonces, signatures, keys, or secrets;
- cross-tenant-comparable raw content hashes.

Private artifacts require tenant isolation, access audit, encryption at rest and
in transit, explicit retention, deletion evidence, and operator access policy.

## 10. Proposed closed failure vocabulary

This exact set is **proposed**, not ratified:

```text
SEALED_EXPORT_PROFILE_UNCERTIFIED
SEALED_EXPORT_BINDING_UNQUALIFIED
SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE
SEALED_EXPORT_CAPTURE_FAILED
SEALED_EXPORT_CAPTURE_INCOMPLETE
SEALED_EXPORT_SIGNER_UNENROLLED
SEALED_EXPORT_SIGNER_EXPIRED
SEALED_EXPORT_SIGNER_REVOKED
SEALED_EXPORT_MANIFEST_INVALID
SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID
SEALED_EXPORT_MANIFEST_BINDING_MISMATCH
SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH
SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH
SEALED_EXPORT_MANIFEST_REPLAYED
SEALED_EXPORT_UPLOAD_SESSION_INVALID
SEALED_EXPORT_CHUNK_UNDECLARED
SEALED_EXPORT_CHUNK_DIGEST_MISMATCH
SEALED_EXPORT_CHUNK_DUPLICATE_CONFLICT
SEALED_EXPORT_CHUNK_ORDER_INVALID
SEALED_EXPORT_CHUNK_SET_INCOMPLETE
SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH
SEALED_EXPORT_ROW_COUNT_MISMATCH
SEALED_EXPORT_BUDGET_EXCEEDED
SEALED_EXPORT_ARTIFACT_EXPIRED
SEALED_EXPORT_STAGING_WRITE_FAILED
SEALED_EXPORT_SEAL_INCOMPLETE
SEALED_EXPORT_APPLY_INCOMPLETE
SEALED_EXPORT_GENERATION_VERIFY_FAILED
SEALED_EXPORT_VISIBILITY_CAS_CONFLICT
SEALED_EXPORT_INTERNAL_ERROR
```

Rules:

- every thrown domain reason is a member;
- an undeclared reason becomes the fixed
  `SEALED_EXPORT_INTERNAL_ERROR`, never an echoed value;
- details expose only fixed field names, booleans, counts, and safe tokens;
- implementation requires an exact vocabulary pin, a runtime consumer pin, and
  a source-level throw-site invariant;
- every negative test has a positive control and a mutation that demonstrates
  the intended guard carries the failure.

## 11. Smallest real capability test

This spike alone does not unblock a sealed-export/unbounded entity-machine run.
It does not block #4628's independent bounded path: a newly approved config
that proves `SHORT_PAGE` may still proceed under that issue's existing staged
rules. After separately authorized implementation and certification, the
smallest real test that can justify a sealed-export second run is:

1. Use a first-party engine instance and an entity-machine-equivalent Windows
   agent package pinned to exact service and helper SHAs.
2. Use a private fixture whose result is larger than the bounded-read admissible
   capacity and produces at least three chunks. Publish no row values, source
   identifiers, endpoints, or business limits.
3. Enroll and pin one per-system signing key.
4. Start one named export action against the isolated fixture, pause it after
   the reader has begun, and mutate a test row from a separate fixture-control
   connection. Resume capture and prove the result is one complete state
   permitted by the claimed source-time mechanism, never a mixed-time rowset.
   The connector performs no source write; this mutation belongs only to the
   isolated capability-test harness. Repeat the control with the claimed
   snapshot mechanism disabled or downgraded: the agent must refuse to sign and
   fail with `SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE`.
5. For the successful attempt, assert the export action was invoked exactly
   once and the unsigned manifest payload was frozen and signed only after
   reader exhaustion and artifact finalization.
6. Upload the first chunk, interrupt transport, restart the upload path, and
   resume from receipts without another source read. The manifest and artifact
   digests must remain unchanged.
7. Tamper one byte in a remaining chunk. It must fail with
   `SEALED_EXPORT_CHUNK_DIGEST_MISMATCH`, write no sealed generation, and leave
   the active generation unchanged.
8. Re-run with the original bytes. Verify signature, binding, schema, snapshot,
   ordered receipts, row count, whole-artifact digest, and canonical multiset
   digest.
9. Apply into an inactive generation in at least two chunks. Assert it is
   invisible after the first chunk.
10. In a separate negative-control run, revoke the signing key after the final
    chunk is accepted but before activation. Seal/apply/activation must fail
    with `SEALED_EXPORT_SIGNER_REVOKED`, the generation must become
    `QUARANTINED`, and the active pointer must remain unchanged. A new manifest
    under that key is also rejected.
11. With a non-revoked key in the successful run, complete verification,
    perform the CAS flip, and assert the generation becomes visible only after
    the flip.
12. Concurrently attempt to create two sessions for one export request, then
    replay the manifest after private cleanup. Exactly one session/generation
    may exist, and the later replay must fail with
    `SEALED_EXPORT_MANIFEST_REPLAYED`.
13. Verify values-free public evidence, private cleanup, flag restoration,
    health restoration, and `externalWrite=false`.

Required real evidence:

- exact package and source SHAs;
- real engine and agent versions;
- source-read invocation count per attempt;
- concurrent fixture-mutation timing and the resulting source-time proof class;
- manifest digest continuity across resume;
- chunk receipt set;
- pre-flip and post-flip visibility probes;
- one-byte tamper failure;
- pre-activation revoked-key quarantine and unchanged active pointer;
- concurrent-start and post-cleanup replay failures;
- final cleanup result.

Hermetic tests may cover the rest of the failure matrix, but they cannot replace
the real engine, real signing implementation, interrupted transfer, private
staging, and concurrent CAS probes.

## 12. Proposed implementation slices

These slices describe dependency order only. **They are not authorization.**

| Slice | Deliverable | Explicitly excluded |
|---|---|---|
| S0 decision lock | Ratify the profile coordinate, manifest schema, key lifecycle, failure vocabulary, budgets, and test predicates | Code |
| S1 latent contracts | Cross-language canonical vectors, manifest/request validators, lifecycle state machine, compliance harness | Routes, source reads, storage writes |
| S2 producer feasibility | Connector-owned named export action in a test harness, streaming file/chunk producer, real-engine capture proof, signing | Product registration, deployment |
| S3 private ingestion | Upload session, chunk receipts, private blob/staging storage, resume and cleanup | Runtime consumer, active visibility |
| S4 generation kernel | Generation tables, DB lease/CAS, seal verification, inactive apply, active pointer | Scenario arming, customer rollout |
| S5 profile certification | Concrete read-action profile, binding qualification, first-party package/provenance verification | Runtime wiring |
| S6 controlled runtime | Flag-gated consumer, entity-machine package, staged negative/positive acceptance | General rollout, external write |

Each slice requires:

- exact-head review;
- closed-vocabulary and fail-closed tests;
- load-bearing mutations with positive controls;
- current-main rebase and fresh CI;
- a separate owner decision before the next slice.

## 13. Owner decision packet

The spike recommends the following owner ruling:

1. **Choose sealed export as the preferred feasibility path for the current
   legacy bridge**, because no durable source snapshot/cursor exists today.
2. **Keep durable cursor as an eligible alternative by capability**, but open it
   only after a source proves a native durable snapshot identity and stable
   cursor across reconnect.
3. **Do not treat the current large-BOM job as the scale substrate.** Reuse only
   its contract shapes; require new private staging, generation isolation, DB
   lease/CAS, and visibility flip.
4. **Require a real-engine capture-semantics spike before profile
   certification.** Manifest signing alone is not snapshot proof.
5. **Keep #4628 independent.** A genuinely bounded approved config may proceed
   without waiting for this line; repeated use of the same unprovable config is
   not an experiment.

## 14. Boundaries

- PROPOSED / SPIKE ONLY.
- No runtime code or workflow changed.
- No concrete profile is certified.
- No new route, storage schema, migration, key, package, or artifact is created.
- No page limit is raised.
- No existing completeness guard is weakened.
- No deployment, flag enablement, external write, or rollout is authorized.
- No customer value, identifier, endpoint, credential, path, filter, or
  business limit is recorded.
