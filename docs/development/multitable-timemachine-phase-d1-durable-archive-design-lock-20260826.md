# Phase D / D1 -- durable recovery archive design lock (2026-08-26)

- **Status: PROPOSED / owner-ratify-before-runtime.** This file is a design lock, not a runtime
  authorization. Owner ratify (exact SHA of this file) is required before **any** D2+ implementation
  merge, **including default-off schema**. Docs-only amendments to this D1 file itself are not D2+
  implementation and may land without that merge authorization. Ratification, if granted, authorizes
  default-off implementation slices only. It does **not** authorize a flag, trigger ENABLE, host
  mutation, staging cutover, production rollout, real-customer data read, or WAL/object backup
  reclassification.
- **Grounding:** `origin/main` `efbf0a931cd6529703a91c9c0053d4cae8217abe` (2026-08-26). Citations
  below are orientation anchors on that commit and must be refreshed before implementation.
- **Authority this file claims:** D1 archive contract for Phase D only (v3.7 §12 product boundary +
  current-main seams). It does not rewrite Phase A/B semantics, E1, or O-2 ladder order.
- **Authority this file does not claim:** runtime proof, enablement, or "recoverable after
  hot-history retention" as a product promise. Completing D1 is design evidence. Completing D2-D7
  with mutation-proven goldens is implementation evidence. Completing owner/ops enablement is a
  separate claim.

## 0. Authority, supersession, and non-authorization

### 0.1 Sources of truth (priority order)

1. **Product/dependency contract (durable):** `docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md` **§12**
   (roadmap addition 2026-07-17). §12 is PLANNED / design-lock-required. It does not ratify runtime.
   Design semantics in v3.7 §1-§6 (exact operation anchor, bigint seq, sealed endpoint, fence,
   checkpoint, preview identity) remain the recovery substrate. This D1 lock does not reopen them.
2. **Integration order (durable):** v3.7 §11 + live pointer
   `docs/development/multitable-w0-substrate-integration-status-20260716.md` §Phase D planned.
   Order: Phase B frozen on `main` -> **D1 (this file)** -> D2 archive-before-prune -> D3 catalog ->
   D4 reconstruction -> D5 restore -> D6 UI -> D7 staging evidence.
3. **Exact-anchor development/verification (landed substrate, flags default-OFF):**
   - `docs/development/multitable-time-machine-exact-anchor-recovery-development-verification-20260721.md`
   - `docs/development/multitable-time-machine-exact-anchor-closeout-development-verification-20260811.md`
     (#4654 `12f1f8c466`, inert landing). `RECONSTRUCTION_CAUSALITY_LANDED = true` is a **code const**
     for L8 route wiring, not an env flag (`history-trust-precondition.ts:37`). It is **not** proof that
     replay is floor-aware; see discovered P1 in §1.4.
4. **#4446 resurrect reference (HISTORICAL REFERENCE DESIGN, not deployable):**
   `docs/development/multitable-4446-resurrect-reference-design-20260812.md`. Reusable: trash
   live/trash mutex, outbound `NOT EXISTS` insert, at-anchor snapshot over trash vintage,
   all-or-nothing rollback shape. Must-redo: at-anchor **inbound** link authority, authorization
   to run resurrect, route wiring. Current main still fail-closes resurrect at preview
   (`exact-anchor-recovery-route.ts:494-509,696-701`, `INBOUND_UNPROVABLE`).
5. **Enablement (out of this lock):** O-2 ladder
   `docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md` (RATIFIED order/criteria;
   **E1 remains PROPOSED / owner-held**; L2+ HOLD). L1 CLOSED evidence is
   `docs/development/multitable-timemachine-l1-closure-20260826.md` and does not authorize L2+ or
   Phase D. Phase D is registered as uncoupled (`o2-enablement-ladder` §4).

### 0.2 What is frozen vs what this lock may decide

| Frozen on this baseline | This D1 lock may ratify (still default-off after owner SHA) |
|---|---|
| Phase B merge order L5-wire -> L6-b -> L7 -> L8 is on `main`, flags OFF | Archive manifest versioning, hashes, binding, storage adapter **interface** |
| PIT Reset x retention fail-closed `RESET_RETENTION_CONFLICT` | Archive-before-prune **handoff contract** (does not flip the current guard) |
| Resurrect fail-closed until inbound authority exists | That D4 is the single reconstruction authority; D5 consumes it |
| Token-bound `anchorSeq`; wall-clock `T` is display-only | Async job claim vs token burn; lifecycle; values-free ordinary logs vs access-controlled catalog |
| Current replay `seq <= anchor` with overlay-fill-absent-only (discovered P1, §1.4) | **Not** claimed complete. D2+ depends on a separate floor-aware correction |
| E1 / L2+ / five recovery flags | **Nothing.** No flag name in this file is an activation authorization |

### 0.3 Explicit non-authorization (load-bearing)

This document:

- does **not** add, rename, or flip any env flag;
- does **not** register a new flag in `scripts/ops/global-history-flag-manifest.mjs` (D2+ must, if a
  flag is introduced, in the same change that adds the reader);
- does **not** authorize `MULTITABLE_META_REVISION_RETENTION_ENABLED=1` or any recovery flag;
- does **not** relax `RESET_RETENTION_CONFLICT`;
- does **not** authorize resurrect, permission restore, cross-sheet atomicity, or production;
- does **not** reclassify external DB/WAL/object backups as Time Machine evidence (v3.7 §12.7).

Any later D2+ PR that lands schema or code stays inert unless an **owner-ratified, manifest-registered
flag** is exact-literal ON. Flag-off byte parity with this baseline is a D2 acceptance gate, not a
hope.

## 1. Current-source facts (code-grounded; not invented)

Line numbers are this baseline. No archive table, archive API, or archive module exists under
`packages/core-backend/src/multitable` (repo grep for `archive` in that tree: zero). Names in §3
marked **provisional** are proposals, not schema.

### 1.1 Identity and hot tables

| Fact | Path / symbol |
|---|---|
| Workspace (closest current "tenant" handle) is `meta_bases.workspace_id`; sheet binds `meta_sheets.base_id` | `zzzz20260318110000_add_multitable_bases_and_permissions.ts:7-24` |
| No separate `tenant` table is a current recovery key | Do not invent one as a settled fact |
| Sealed operation endpoint: `meta_record_history_operations(sheet_id, operation_id, endpoint_seq bigint, event_count)` PK `(sheet_id, operation_id)` | `zzzz20260715210000_create_meta_record_history_operations.ts:72-79`; `operation-ledger.ts` `sealOperation` / `pruneSealedOperation` |
| Checkpoint SM: `meta_history_trust_checkpoints.state IN ('building','active','superseded')`; baselines `meta_history_baselines` | `zzzz20260715180000_create_meta_history_trust_checkpoints.ts:62-100`; `history-trust-checkpoint.ts:79,368` `pruneRetainedCheckpoints` |
| Exact bigint: seq as decimal string; SQL `::bigint`; `Number`/`parseInt`/`+` forbidden | `history-trust-checkpoint.ts:20-75` `isSeqString` / `assertSeqString` / `compareSeq` |
| System sheet kinds denormalized on checkpoint: `people_directory`, `approval_projection` | `history-trust-checkpoint.ts:82-83` `SYSTEM_SHEET_KINDS` |
| Record log `meta_record_revisions`; config log `meta_config_revisions`; markers `meta_record_version_markers` | retention + ledger FKs as cited below |
| Live records `meta_records`; trash `meta_records_trash`; links `meta_links` (no `foreign_record_id` FK; containment invariant) | closeout verification; `live-link-projection-integrity.ts:30-49` |
| Auto-number `meta_field_auto_number_sequences` | `auto-number-service.ts:47-50`; capture note in `tombstone-capture.ts:26-34` |
| Attachments `multitable_attachments` (`storage_file_id`, `storage_path`, `storage_provider`, `deleted_at`, `blob_purged_at`) | `attachment-service.ts:426-475` `storeAttachment`; migrations `zzzz20260319103000_create_multitable_attachments.ts`, `zzzz20260711090000_add_multitable_attachments_blob_purged_at.ts` |
| Token burns `meta_recovery_token_burns(token_sha256 PK, sheet_id, actor_id, burned_at)` -- hash only, no raw token | `zzzz20260719120000_create_meta_recovery_token_burns.ts:27-33`; insert `exact-anchor-recovery-execute.ts:916-926` |

### 1.2 Retention prune seam (hot history; no archive handoff today)

`startMetaRevisionRetention` (`meta-revision-retention.ts:333-370`) is a no-op unless
`MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'` (not `'true'`; manifest R4). When ON it sweeps,
isolated per table:

- `sweepMetaRevisionRetention` -- `meta_record_revisions`; never deletes latest per record (`:83-120`)
- `sweepConfigRevisionRetention` -- `meta_config_revisions` (same knob, T9 D4)
- `sweepFieldValueTombstoneRetention` / `sweepLinkTombstoneRetention` -- keep-days on
  `meta_field_value_tombstones` / `meta_link_tombstones` (`:296-308`)

Whole-operation prune is a **different** seam: `pruneSealedOperation` -> SQL
`meta_record_history_operations_prune(sheet_id, operation_id)` under GUC `metasheet.mrho_retention`
(`operation-ledger.ts:172-186`; H1/H2 in the operations migration `:42-57,254-264`). Ordinary
endpoint DELETE stays fail-closed. Trailing GUC-off is load-bearing (G2).

Checkpoint prune: `pruneRetainedCheckpoints` (`history-trust-checkpoint.ts:368-398`) tombstones
`pruned_at` below the **anchor-covering** floor, not active-only.

**None of these callers consult an archive.** A failed/missing archive therefore cannot currently
block prune, because no archive exists. D2 must add that handoff; D1 must not pretend it is present.

PIT Reset remains blocked while retention is enabled, **before DB work**:
`univer-meta.ts:10350-10357,10734,10836` -> `409 RESET_RETENTION_CONFLICT`. v3.7 §12.1: Phase D is
required before this conflict may be reconsidered. This D1 lock does not reconsider it.

### 1.3 Exact-anchor composed-map seam (current main; not a causal floor)

Destructive authority is not wall-clock. The following is the **current** compose path. This lock
does **not** call it at-anchor-exact or causality-complete (discovered P1, §1.4).

1. `resolveExactAnchor` refuses `{kind:'wall-clock'}` before DB access (`exact-anchor-recovery.ts:38-61,67`).
2. Anchor = sealed `operation_id`; `anchorSeq = endpoint_seq::text` (`:244-257`).
3. Replay: `reconstructRecordsAtSeq` (`record-reconstructor.ts:101-129`) selects
   `WHERE sheet_id = $1 AND seq <= $2::bigint` (`:117-123`). There is **no** `trusted_since_seq`
   lower bound. Every retained revision at or below the anchor is eligible, including pre-floor rows.
4. Overlay: `composeBaselineOverlay` (`exact-anchor-recovery.ts:158-179`) reads
   `meta_history_baselines` and **only inserts records absent from the replay map**
   (`:169` `if (composed.has(recordId)) continue`). In-tree comments calling that replay
   "at-anchor-exact" (`:150,169`) are **not** accepted as a D1 fact. A pre-floor replay row that
   is present shadows the checkpoint baseline.
5. Classifier: `classifyExactAnchorRecoveryPlan` (`exact-anchor-recovery-plan.ts:148`) is pure;
   production callers compose the overlay first (`:39-43`).
6. Display-only `reconstructRecordsAtT` (`record-reconstructor.ts:47`) stays **not** an archive
   reconstruction authority.
7. Strict precheck enumerates the **unbounded** sheet timeline: `precheckSheetHistoryIntegrityStrict`
   loads `meta_record_revisions` / markers `WHERE sheet_id = $1` with no seq floor
   (`history-integrity-precheck.ts:641-646`).

Apply is one real transaction, fence-first when the writer-fence flag is ON, then trust-pair, then
token burn, then in-fence re-hash (`exact-anchor-recovery-execute.ts:818-945`). Mode comes from
verified claims only (P1-1). Size ceiling: `resolveSheetRevertMaxRecords` default **5000**,
fail-closed not truncated (`restore-caps.ts:15-19`; v3.7 §12.4).

### 1.4 Discovered P1 -- reconstruction floor (prerequisite, not claimed complete)

**P1 (discovered on this baseline, not fixed by this docs lock):** the current compose seam is **not**
a causal floor.

| Current behavior | Why it is not a floor |
|---|---|
| `reconstructRecordsAtSeq` `seq <= anchorSeq` | Pre-checkpoint / pre-cutover / untrusted rows still win if they exist |
| Baseline fills **absent** keys only | Cannot displace a present pre-floor replay row |
| Strict precheck `WHERE sheet_id = $1` | Validates the whole chain, not `trusted_since_seq < seq <= anchor` |

`RECONSTRUCTION_CAUSALITY_LANDED` records that L8 is wired onto this seam. Wiring != floor-aware
replay. D2+ archive reconstruction **must not** ship on this query shape.

**Required separate correction (outside this D1 file; D2+ depends on it):**

1. Replay reads `trusted_since_seq < seq <= anchorSeq` (exclusive floor, inclusive anchor; exact
   bigint strings / SQL `::bigint`).
2. Strict validation is floor-aware on the same window (not an unbounded sheet scan).
3. Real-DB + mutation evidence that a pre-floor revision present in hot history cannot change the
   composed map when a covering checkpoint exists.

Until that correction is on `main` with evidence, D4 must not treat current `reconstructRecordsAtSeq`
as the archive reconstruction primitive, and this lock must not describe current replay as
at-anchor-exact.

### 1.5 Attachment and link/tombstone facts

- `storeAttachment` writes a DB row **after** `storage.upload`; DB failure best-effort deletes the
  blob (`attachment-service.ts:426-483`). Inverse is also true: a live row is **not** proof the blob
  still exists (orphan cleanup / blob purge / ENOENT-as-success in
  `attachment-orphan-retention.ts:82-99,206-258`).
- Orphan cleanup (`cleanupOrphanMultitableAttachments`) deletes `record_id IS NULL` after retention
  hours; default ON in `NODE_ENV=production` unless
  `MULTITABLE_ATTACHMENT_CLEANUP_ENABLED` is set (`:69-74,82-99`). Blob purge
  (`sweepMultitableAttachmentBlobPurge`) is opt-in
  `MULTITABLE_ATTACHMENT_BLOB_RETENTION_ENABLED === 'true'` (`:206-258`). Path containment:
  `resolveWithinBase` (`StorageService.ts:43`; used at `attachment-orphan-retention.ts:47`).
- Tombstone capture (`tombstone-capture.ts:1-25`) is same-txn, before the destructive statement,
  gated `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED === 'true'` (default OFF = today's bytes). Forward-only:
  destruction before the flag has **no** tombstone (`zzzz20260708090000_create_meta_tombstone_tables.ts:13-15`).
- Inbound replay `replayInboundLinks` (`inbound-link-replay.ts:89-118`) keys
  `meta_link_tombstones` by `source_revision_id` + `reason='record_delete'` -- **terminal delete
  vintage**, not at-anchor inbound. Exact-anchor resurrect remains refused (`INBOUND_UNPROVABLE`).
- Outbound live authority is `meta_links`, not `data` (`live-link-projection-integrity.ts:52-59`).
  `meta_links` has no unique constraint on the edge triple (#4446 reference §②(c)); inserts use
  `NOT EXISTS`. Duplicate edges fail closed in recovery hashing (`hashExactAnchorLiveSet`,
  `restore-preview-identity.ts:647-665`).
- Preview identity binds sheet, `anchorOperationId`, decimal `anchorSeq`, `checkpointId`, actor,
  mode, `scopeHash`, `liveSetHash`, `schemaHash`, `authorizedScopeHash`
  (`restore-preview-identity.ts:668-701` `mintExactAnchorRecoveryIdentity`).

### 1.6 Adjacent writers that share sheet bytes

These already take (or must observe) the canonical fence when `MULTITABLE_ENABLE_WRITER_FENCE` is ON:

| Writer | Seam |
|---|---|
| Ordinary record writes | `record-write-service.ts` / `records.ts` `fenceWriterEntry` |
| Derived formula/lookup/rollup materialization | `derived-write-fence.ts:1-40` `applyFencedDerivedDataMerge` (revision-exempt) |
| Exact-anchor apply | `acquireCanonicalSheetFencesInOrder` + `claimDurableWriterBlock` (`canonical-sheet-fence.ts:91,180,197`) |
| Approval form writeback | `approval-fwb-record-link.ts` / automation executor FWB actions |
| Automation durable outbox | `automation-durable-dispatcher.ts:16-32` `FOR UPDATE SKIP LOCKED` + fence-CAS (`fence` bigint as **string**) |
| Attachment orphan/blob sweeps | independent of the sheet fence; can delete blobs an archive later needs |

`workflow-job-contract.ts` is **contract-only, not imported by runtime** (`:1-15`). Do not treat it
as a live job table.

## 2. Product contract carried forward from v3.7 §12 (not reopened)

1. Two horizons: **history retention** (hot events) vs **recovery retention** (verified immutable archives). Independently configured. Archive expiry != hot expiry.
2. **Archive-before-prune:** hot history for a covered range may be pruned only after the matching
   archive is durable, tenant/sheet-bound, complete, and independently verified. `building` / missing
   / corrupt / unverifiable never authorizes prune. Failed archive write leaves hot rows intact.
3. Immutable after verification. Corrections = **new generation**, never in-place edit of a verified
   payload. Deletion after the recovery horizon is explicit, auditable, values-free.
4. V1 archive is **single-sheet** and exact-operation anchored (`anchorOperationId` + bigint
   `anchorSeq` + checkpoint). Customer-facing "sheet version" is that recovery point, not
   `meta_records.version`, not wall-clock `T`.
5. Three restore modes: whole sheet; selected records; selected fields across those records.
   Preview-first. Execute creates new `source='restore'` revisions and a **new** sealed endpoint.
   It never rewrites historical rows. Restore itself becomes a future exact anchor.
6. Sync path may reuse L8 all-or-nothing under the existing 5000-record ceiling. Above that:
   asynchronous, frozen plan/hash, idempotent operation id, progress, retry/resume, explicit
   partial-completion. **No v1 cross-sheet long transaction.**
7. Permission policy restore is a separate high-risk tier: archive **may** keep permission evidence
   for audit; data restore **must not** overwrite current authorization.
8. Formula/lookup/rollup: restore definitions/source inputs and recompute; stale derived bytes are
   not authority (`derived-write-fence.ts` writes are already revision-exempt).
9. **Cannot recover bytes never archived or never captured** (v3.7 §12.7; tombstone C1). Those
   cases are `unavailable`, not guessed.

### 2.1 Threat model

This is a ratifiable integrity contract (closes with D-D / D-F). Unkeyed hashes alone are **not**
authenticity.

| Actor / failure | What they can do if integrity is hash-only | Required control |
|---|---|---|
| Accidental corruption | Truncate or bit-rot a section object; hash mismatch on read | Section SHA-256 over **canonical plaintext**; AEAD auth-tag fail-closed |
| Storage adversary | Rewrite ciphertext **and** the unkeyed section/root hashes in the stored manifest so they match | AEAD on section bytes **plus** a KMS-backed signature or MAC over the canonical manifest/root, using a key the object store does not hold |
| Cross-binding mixup | Present sheet B's archive as sheet A's | Manifest MAC binds format/version/generation/workspace/base/sheet/anchor/checkpoint/created_at/expiry/key metadata |
| Wrong or rotated key | Decrypt with a different `key_id` or omit the tag | Refuse before any live write; mutation golden |
| Tampered manifest | Change binding fields or section-hash list while keeping objects | Manifest MAC/signature verify first; golden |
| Sweeper vs builder race | Purge a blob while an archive of it is `building` | Pin-intent before blob read (§3 D-G) |
| Hot DB/host loss | Local archive files on the same host vanish with the DB | Production backend must sit outside that failure domain (§3 D-E) |
| Log oracle | Ordinary logs emit workspace/base/sheet/actor/recovered values | Catalog vs ordinary-log split (§3 D-M) |

**Integrity construction (normative for D2 verify):**

1. **Section hashes cover canonical plaintext only**, never ciphertext. Hash input = the same
   canonical JSON (D-A) of that named section.
2. **Stored section bytes** are AEAD (authenticated encryption). Associated data (AAD) binds the
   full archive identity: `format_version`, `archive_generation_id`, workspace_id, base_id,
   sheet_id, `anchorOperationId`, decimal `anchorSeq`, `checkpointId`, and section name. Verify =
   AEAD open (auth tag) **first**; on tag failure refuse without hashing. On success, SHA-256 the
   recovered plaintext and compare to the manifest section hash.
3. **Canonical manifest body (root preimage)** includes: `format_version`, `archive_generation_id`,
   workspace/base/sheet ids, `anchorOperationId`, decimal `anchorSeq`, `checkpointId`, the literal
   manifest field **`created_at`** (v3.7 §12.3 creation time; required, not optional commentary),
   `expires_at`, `source_vector_hash`, and the format-version exact ordered section descriptors
   `{name, row_count, plaintext_sha256, aead_algorithm, key_id, wrapped_dek_id, dek_fingerprint,
   nonce}`. `dek_fingerprint` is a domain-separated, KMS-backed opaque identity of the unwrapped DEK,
   not a hash of the randomized wrapped blob and never raw key material.
   `row_count` is a canonical decimal string and is recomputed after decrypt/parse from the exact
   canonical logical rows (zero is explicit, never omitted). Duplicate entity keys, duplicate or
   unknown sections, and any missing required section refuse. Ciphertext, auth tags,
   **`root_hash`, and signature/MAC
   fields are excluded from this preimage** (no circular hash). Stored `root_hash` = SHA-256 of
   that canonical body.
4. **KMS-backed signature or MAC** (authenticated binding) covers a domain separator + the stored
   `root_hash` + the same binding metadata as the body, which **must include the literal field
   `created_at`** along with `format_version`, generation, workspace/base/sheet, anchor,
   checkpoint, `expires_at`, `source_vector_hash`, and key metadata. The object store MUST NOT hold the MAC key. Verify
   the MAC/signature **before** trusting `root_hash`, any section hash, or opening restore.
5. A storage adversary who rewrites payload+manifest+unkeyed-hashes still fails step 4.

Required goldens (D2/D7, mutation-proven): **wrong-key** (verify/restore with a different or
missing `key_id` => refuse, zero live writes); **tampered-manifest** (rewrite section bytes and
matching unkeyed hashes, leave MAC/signature as stored => refuse). Auth-tag fail and truncated
ciphertext are the accidental-corruption pair.

## 3. Ratifiable decisions (recommendations; 2-3 forks each)

Owner ratify accepts or replaces the **Recommended** column. Alternatives are recorded so a later
implementer cannot treat a rejected fork as an oversight.

### D-A -- Manifest canonicalization and versioning

| Fork | Shape |
|---|---|
| **R (recommended)** | RFC 8785 JCS bytes + integer `format_version` + opaque `archive_generation_id` + canonical UTC timestamps. Each format version owns an exact required section/key set; duplicate, missing, unknown, or out-of-order section descriptors refuse. Additive fields require a version bump. |
| A2 | Protobuf / flatbuffer as the byte authority |
| A3 | Pretty JSON / insertion-order objects as the hash input |

**Rationale:** hash stability is the integrity mechanism; pretty JSON or a home-grown insertion-order
serializer is not. A binary codec is a new toolchain with no current consumer. Timestamps are UTC
RFC3339 with one locked precision; bigint seqs and section `row_count` are canonical non-negative
decimal strings. Hashes are lowercase 64-character hex. **Provisional** root object name:
`RecoveryArchiveManifest` (TypeScript type only until D2).

### D-B -- Archive generation state machine

| Fork | Shape |
|---|---|
| **R** | Payload SM exactly v3.7 §12.2: `building -> verified -> expired`. Corrections mint a **new** generation. Catalog records `superseded_by_generation_id` separately without changing the immutable payload state. Only `verified` **and** `coverage_status='complete'` authorizes prune. `expired`, `building`, or incomplete coverage never does. |
| B2 | First-class `superseded` as a payload state (fourth value on the object) |
| B3 | Mutable in-place status on one row, including rewriting hashes |

**Rationale:** B3 is forbidden by §12.2. B2 overloads payload identity. Catalog `superseded` is
observability, not a second payload editor.

**Provisional** catalog table: `meta_recovery_archives` (columns illustrative: `id`, `sheet_id`,
`base_id`, `workspace_id`, `anchor_operation_id`, `anchor_seq` text, `checkpoint_id`,
`generation_id`, `format_version`, payload `state`, catalog `build_status`, `coverage_status`,
`root_hash`, `source_vector_hash`, `key_id`, `superseded_by_generation_id`, `expires_at`,
`created_at`). Legal hold is normalized under D-L; a cached boolean on this row is never hold
authority.

The immutable payload state remains exactly `building -> verified -> expired`. Catalog
`build_status` is a separate closed lifecycle `active -> finalized|abandoned`. `finalized` requires a
verified payload. Any claim/capture/upload/finalize failure CASes the exact build owner/fence from
`active` to `abandoned`; it can never later become verified. Owner/fence-safe cleanup may release its
pins/key reference only after all generation-scoped staging objects are deleted or confirmed absent.
Until that proof, the abandoned attempt remains a key/pin reference. This is not a fourth payload
state and does not rewrite verified bytes.
Not created by this lock.

### D-C -- Tenant / base / sheet / anchor binding

| Fork | Shape |
|---|---|
| **R** | Bind **current** identity: non-NULL `meta_bases.workspace_id` + `meta_sheets.base_id` + `sheet_id` + `anchorOperationId` + decimal `anchorSeq` + `checkpointId` + `archive_generation_id` + `source_vector_hash` + `created_at` (v3.7 §12.3). Cross-workspace / cross-base / cross-sheet read or prune handoff = refuse. A NULL workspace refuses archive and restore unless a later owner-ratified legacy-tenant mapping supplies a non-NULL authority. |
| C2 | Bind `sheet_id` + anchor only |
| C3 | Invent a new `tenant_id` column/table as the v1 key |

**Rationale:** C2 cannot prove tenant isolation. C3 invents a table that does not exist. v3.7 §12.3
says "tenant/base/sheet identity"; the current columns are workspace/base/sheet.

V1 **excludes** `SYSTEM_SHEET_KINDS` sheets (`people_directory`, `approval_projection`) unless a
later lock says otherwise: those are platform projections, not customer recovery points.

### D-D -- Root / section hashes, authenticity, and bigint representation

| Fork | Shape |
|---|---|
| **R** | Per-section SHA-256 over **canonical plaintext** (not ciphertext). Root preimage = canonical manifest **body** in §2.1 (binding fields including `created_at` and `source_vector_hash`, format-version exact section set, canonical row order, decimal-string `row_count`, and plaintext hashes) **excluding** `root_hash` and signature/MAC fields. Stored `root_hash` = SHA-256(preimage). MAC/signature covers domain separator + `root_hash` + the same binding metadata. Verify recomputes row count after decrypt/parse; duplicate entity keys refuse. `anchorSeq` / any seq is a decimal integer **string** (`assertSeqString` / `compareSeq` / SQL `::bigint`). Unkeyed hashes detect accidental corruption only. Authenticity = AEAD on section bytes + KMS-backed MAC/signature (§2.1). |
| D-D.2 | Merkle tree of per-row hashes as a v1 requirement |
| D-D.3 | Unkeyed SHA-256 / CRC / xxhash as the **sole** integrity authority (payload+manifest+hash rewrite succeeds) |

**Rationale:** D-D.3 is the storage-adversary hole. D-D.2 can wait; v1 needs whole-section verify plus
manifest authenticity. Merkle is extra, not a substitute for the MAC.

**V1 required section names, in this exact order:** `schema`, `records`, `links`,
`field_value_tombstones`, `link_tombstones`, `auto_number`, `attachments_index`,
`permission_evidence` (audit-only), `views_config`, `coverage_index`. Zero-row sections are present with
`row_count='0'`; omission, duplication, an unknown section, or a different order refuses. Rows in
each section are one exact envelope `{ "entity_key": string, "payload": object }`, with no unknown
envelope keys, and sort by the UTF-8 bytes of `entity_key` before JCS serialization. `row_count` is
the decimal-string length of that outer array only; nested payload arrays do not contribute. Duplicate
`entity_key` values refuse. Format v1 fixes the key and payload projection below; adding/removing a
payload key or changing a key derivation requires a format bump and a separately reviewed reader.

| Section | `entity_key` | Exact v1 payload authority |
|---|---|---|
| `schema` | `field/<field_id>` | `field_id,name,type,property,order`; timestamps and sheet id are bound by the manifest, not repeated |
| `records` | `record/<record_id>` | `record_id,exists,version,data`; `data=null` iff `exists=false` |
| `links` | `link/<meta_links.id>` | `link_id,field_id,record_id,foreign_record_id` |
| `field_value_tombstones` | `field-tombstone/<id>` | the exact row id plus `field_id,record_id,config_revision_id,value,reason,created_at` |
| `link_tombstones` | `link-tombstone/<id>` | the exact row id plus `source_revision_id,field_id,record_id,foreign_record_id,reason,created_at` |
| `auto_number` | `field/<field_id>` | `field_id,next_value`; integers use canonical decimal strings |
| `attachments_index` | `attachment/<attachment_id>` | `attachment_id,record_id,field_id,immutable_object_version,plaintext_sha256,size_bytes,media_type,deleted`; no URI |
| `permission_evidence` | `scope/<authorized_scope_hash>` | zero or one audit row: `authorized_scope_hash,policy_epoch_hash,captured_at_seq`; never a restorable grant set |
| `views_config` | `view/<view_id>` | `view_id,name,type,filter_info,sort_info,group_info,hidden_field_ids,config`; canonical JSON values, no timestamps |
| `coverage_index` | `coverage/<source_kind>/<source_id>` | `source_kind,source_id,source_seq,source_sha256,bound_section`; `source_seq` is a decimal string or NULL; this derived section never covers itself |

D2 must fail its migration/design gate if a cited source table lacks a stable row id needed above;
it may not substitute array position or wall-clock time. A later schema column that is not in this
projection is intentionally absent from format v1 until a format bump.

### D-E -- Backend-neutral storage adapter

| Fork | Shape |
|---|---|
| **R** | Interface-only adapter (put/get/head/deleteExpired + pin). Goldens mock the interface and must not require a named cloud vendor. **Local filesystem is test/staging only**, unless that filesystem is independently durable **and** outside the hot DB/host failure domain. Production backend acceptance must prove durability and failure-domain separation (archive remains readable if the hot Postgres host is gone). Path containment for any local impl: `resolveWithinBase`. |
| E2 | Store payloads as Postgres `bytea` in the catalog / hot database |
| E3 | Hard-wire one object-store vendor in D2 |

**Rationale:** §12.3 requires backend-neutral goldens. E2 couples recovery retention to the hot DB
the archive exists to outlive. A same-host `data/attachments`-style tree does not survive that
host. **Provisional** type: `RecoveryArchiveObjectStore`. Ordinary logs: no URI.

### D-F -- Encryption, key metadata, rotation, and manifest MAC

| Fork | Shape |
|---|---|
| **R** | Envelope **AEAD** for each section object (ciphertext + auth tag; unique nonce per DEK/object; AAD as §2.1). The root-bound section descriptor stores `key_id`, algorithm id, nonce/wrapped-DEK metadata, and a KMS-backed opaque `dek_fingerprint` -- **not** raw keys. Before any section bytes are encrypted, sealed, or uploaded, D2 durably reserves every globally unique `(dek_fingerprint, nonce)` pair in an immutable catalog registry; collision abandons the build while no ciphertext exists. That reservation does not cascade with archive/object expiry and is never auto-pruned, so deleting an old ciphertext cannot make its pair reusable. Reusing the same nonce under a provably different DEK is not forbidden. KMS-backed signature or MAC covers the canonical manifest/root; object store does not hold that key. Rotation = new verified generation (re-encrypt / re-MAC / re-put), never in-place rewrite. Missing/wrong key, tag fail, MAC fail, or same-DEK nonce reuse at reservation, verify, or restore = refuse, zero live writes. Key destruction is a separate owner operation and is refused while any nonexpired/held generation or nonterminal job references the key. |
| F2 | Rely only on disk/volume encryption or unkeyed hashes |
| F3 | Actor-held client keys in v1 |

**Rationale:** F2 does not survive backup-media copy or a storage adversary. F3 is a product/key-custody
design not in §12. Exact KMS product is **not** locked here (owner/ops). The key-custody adapter must
derive `dek_fingerprint` from the actual unwrapped DEK using a domain-separated KMS-backed PRF (or
return an equivalent KMS-attested one-to-one DEK identity); hashing only wrapped ciphertext is not
sufficient because randomized re-wrapping could hide reuse of the same DEK. The nonce registry is a
small values-free safety tombstone, not an object reference; D1 deliberately chooses permanent
reservation over proving that every adversarially retained ciphertext has vanished. Ordinary logs never
contain key material, DEKs, nonces, URIs, or identity fields (D-M).

**No KMS call may run inside a database transaction.** This applies to every D2-D7 path and every KMS
verb: key lookup/unwrap, DEK-identity PRF, manifest MAC/sign, MAC/signature verification, unwrap for AEAD
open, rotation, and external key destruction. A database transaction may persist or recheck only opaque
`key_id`, `dek_fingerprint`, algorithm/version, precomputed MAC/signature bytes or digest, and provider
receipt metadata. Build/finalize computes the canonical manifest/root and obtains its KMS MAC/signature
after object assembly and outside every transaction; the short final CAS transaction then rechecks the
exact immutable root/source vector/key/generation/nonce reservations and persists that precomputed result.
Verify/restore performs KMS verification and unwrap outside the destructive transaction, then the fenced
transaction rebinds the verified bytes to the same immutable catalog row version, root, MAC/signature, and
key metadata before any live write. Any drift forces a new outside-transaction verification; it is never
repaired by calling KMS while locks are held. D2 and D4 test adapters maintain a transaction-depth spy:
every KMS call asserts depth zero. Mutations moving manifest MAC/sign into finalize CAS or MAC/unwrap into
restore apply must red while the unmutated archive and restore paths remain green.

### D-G -- Attachment object availability / pinning (including concurrency)

| Fork | Shape |
|---|---|
| **R** | At archive build, for every attachment id referenced by archived record data **and** every in-scope `multitable_attachments` row: create a generation-owned DB pin, then copy an immutable/versioned source object into the sealed staging bundle and archive store. Record `{attachmentId, content_hash, availability}`. Any missing, mutable-without-version, or hash-drifting source keeps `coverage_status='incomplete'`; that generation cannot become `verified` or authorize prune. |
| G2 | Store DB ids/URIs only |
| G3 | Inline every blob into the manifest JSON |

**Concurrency / handoff order (normative; D2 must mutation-prove):** orphan cleanup and blob purge
(`attachment-orphan-retention.ts:82-99,213-258`) do not take the sheet fence today. Archive build
must not race them as "read then hope". Required order:

1. **Source pin-intent first** (catalog row keyed by `archive_generation_id` + attachment id, class
   `source`, state `building`, lease owner/fence/expiry) that **every source-blob physical deleter**
   treats as an exclusion: orphan cleanup, blob-retention purge, the direct attachment-delete route,
   provider cleanup, and any future bulk source delete. Intent is durable before the blob
   `HEAD`/read. A source backend that
   cannot provide an immutable version/generation or storage-enforced content identity is refused.
2. **Then** copy the exact immutable source version into the generation-scoped sealed staging bundle,
   hash it, and later perform the AEAD put. A concurrent/uncooperative delete, ENOENT, or content
   hash/version change => record `availability: 'missing'|'drifted'`; do **not** treat it as a
   successful pin and do not transition that generation to `verified`.
3. **Verified archive** includes the attachments section (plaintext hashes + AEAD objects + MAC).
   Finalize atomically creates a distinct generation-owned `archive_object` reference for each
   verified archive copy; it is not the source pin under a new name.
4. **Only then** may hot prune of covered revisions/tombstones proceed (D-H). Finalize may release
   this generation's `source/building` pin, after which a source-blob purge may treat the **live**
   object as expendable if ordinary live-data policy also permits it. Releasing the source pin never
   releases or deletes the archived copy.
5. Source-blob deleters MUST skip active `source/building` pins. Archive-object deleters MUST skip
   every `archive_object/verified` reference until the bound generation is expired and its D-L
   deletion intent reaches the external-delete phase. Both key spaces are generation-scoped (or
   independently refcounted), so expiring generation N cannot release generation N+1's source pin or
   archive-object reference. A deleter must name the object class; a generic "any pin" predicate is
   forbidden.
6. Inverse: D-H hot-history prune cannot run while attachments for that coverage are still
   `building`.
7. **Stale `source/building` attachment-pin cleanup** (abandoned pin-intent after crash/timeout) MUST be
   lease/ownership-safe: only the lease holder, or a sweeper that has observed an expired lease
   and CAS-claimed the row, may clear that intent. Stale `building` attachment-pin cleanup must
   **never unpin a live builder or any `archive_object/verified` reference**.

Until D2 pin exists, current sweeps are unchanged (flag-off byte parity). That is current behavior,
not a Phase D defect.

**Rationale:** G2 is the false proof §12.3 forbids. G3 makes the manifest unbounded. Pin-after-read
without intent loses to cleanup/purge/direct delete; a cooperative DB pin without immutable object
identity still cannot prove that the bytes read belong to the captured sheet state.

### D-H -- Archive-before-prune handoff (D2)

| Fork | Shape |
|---|---|
| **R** | Each prune caller that would remove **covered** hot evidence (`sweepMetaRevisionRetention`, config/tombstone siblings, `pruneSealedOperation`, `pruneRetainedCheckpoints`) must see a **verified** archive whose bound `(sheet, anchor/range, generation)` covers that evidence. Else skip/refuse that unit and leave hot rows. Archive write/hash/verify failure => no prune. Flag-off / no archive schema => **today's** behavior (retention still default-off; PIT Reset still conflicts). |
| H2 | Prune first, archive from remaining bytes |
| H3 | Best-effort archive; prune anyway |

H2/H3 are incompatible with §12.2. **This handoff is not implemented by D1.** Current retention
fail-closed and flag-off byte parity are preserved until D2 is owner-ratified **and** its flag is
exact-ON.

Covered range definition (v1): the archive of recovery point `E` covers hot events/tombstones/
checkpoints needed to reconstruct **that** point after the **floor-aware** replay window
(`trusted_since_seq < seq <= anchorSeq`, §1.4) plus checkpoint baseline plus captured
tombstones/links/attachments at E. It does **not** cover later operations. Pruning events **after**
E still requires an archive of those later points if recovery retention claims them. D2 must not
implement coverage against the current unbounded `seq <= anchor` query.

**Operational coverage relation (normative):** D2 adds immutable
`meta_recovery_archive_coverage_items` (name provisional) keyed by
`(generation_id, source_kind, source_id)`, with `source_seq` nullable, `source_sha256`, and the
bound section/root. `source_kind` is a closed enum for record revision, marker, section revision,
config revision, field tombstone, link tombstone, checkpoint baseline, sealed-operation endpoint,
and snapshot/aggregate membership. A prune
candidate is deletable only by an indexed join on its exact stable row id to a coverage item of a
`verified+complete`, nonexpired generation, followed by recomputing its canonical row hash; range
membership or timestamp alone is insufficient. New config/link/tombstone writers also emit the
seq-bearing D-I0 section revision and store that seq in the coverage item. Legacy timestamp-only
rows may be covered only by exact id+hash membership captured in the archive; an unidentifiable or
hash-mismatched legacy row is skipped and retained. Coverage rows are immutable, cascade only with
an owner-authorized archive catalog deletion, and are serialized as the required
`coverage_index` section. Finalize inserts coverage rows only while the parent generation is
`building`, then verifies their exact ordinal/key/count/hash projection against that section before
the MAC-bound root may transition to `verified`; a database trigger rejects coverage INSERT/UPDATE/
DELETE once the parent is not `building`. The catalog stores the authenticated coverage section hash
and row count. Prune requires those values to equal the immutable verified manifest, so copying a
generation id onto a forged coverage row is insufficient. Mutation removing the join, id check,
state check, hash check, immutable trigger, or manifest-section count/hash comparison must prune an
uncovered row and red.

**Existing non-record evidence joins the operation graph explicitly.** D2 adds nullable
`operation_id uuid` to `meta_config_revisions`, `meta_field_value_tombstones`, and
`meta_link_tombstones`, plus indexed `(sheet_id, operation_id)` and a composite FK to the sealed
operation `(sheet_id, operation_id)`. The FK is `DEFERRABLE INITIALLY DEFERRED` because the endpoint is
sealed last in the same writer transaction. Every Phase-D config/tombstone writer inserts its evidence
row, its seq-bearing D-I0 section revision, and the shared non-NULL operation id in that one transaction;
the section event is the endpoint-counted event, while the config/tombstone row is an associated evidence
child and is not double-counted. Pre-D2 rows remain NULL and are legacy row-level candidates only after
exact id+hash archive coverage. A non-NULL operation id can never be backfilled from wall clock, batch id,
or adjacency. Coverage contains an exact id+hash item for both the associated evidence row and its section
revision. Missing either item blocks whole-operation prune.

**Whole-operation prune is not endpoint-only:** every ordinary age sweep must add
`operation_id IS NULL` to its row-level candidate query. Operation-tagged rows are grouped by exact
`(sheet_id, operation_id)` and can be removed only through the covered whole-operation path below;
an operation is eligible only when **all** of its children satisfy their applicable hot-retention
cutoffs. D2 must replace/wrap
`meta_record_history_operations_prune(sheet_id, operation_id)` with a generation-bound form. In the
same transaction, it locks the sealed endpoint, enumerates **every** matching record revision and
version marker, **every v2 section revision**, and every associated non-NULL-operation config/field-
tombstone/link-tombstone evidence row, verifies the kind/version-specific endpoint
count/max/component contract, and joins each child stable id to an exact matching coverage row and
canonical source hash from one `verified+complete`, nonexpired generation. Snapshot/aggregate
membership rows are immutable endpoint components and are deleted only after the same exact
membership/coverage and catalog-reference checks. The endpoint itself must also have an exact
coverage row and no archive/job/catalog identity may still reference it. Only after those checks may
the function set the transaction-local retention GUC and delete all children, memberships, and
endpoint. A missing/extra/hash-drifted child, a count/max mismatch, mixed generations, a young child,
or a concurrent append makes the function delete zero rows and refuse; an endpoint coverage item
alone never authorizes child deletion. Constructed mutations that remove the row-level
`operation_id IS NULL` filter or one revision/marker/section child coverage row must tear an
operation on the unguarded implementation and red.

**Finalize/prune cross-path lock order (normative):** every archive finalize and generation-bound
whole-operation prune takes: (1) canonical sheet fence(s) in sheet-id order; (2) applicable key-registry
rows in key-id order; (3) the sheet writer-block row; (4) archive generation rows in bytewise generation
id order; (5) sealed endpoints in `(endpoint_seq, operation_id)` order; (6) coverage rows in
`(source_kind, source_id)` order; (7) snapshot/aggregate memberships in parent/ordinal order; then
(8) hot evidence children in a fixed table-rank plus stable-id order. Finalize requires the exact active
archive owner/fence. Prune requires no active writer block and refuses rather than reaching around an
archive builder; it performs no provider or KMS call while the transaction is open. No path may lock an
endpoint, coverage row, membership, or child and then request a fence, key, block, or generation row.
A two-connection barrier golden must show prune waiting at the common fence before it owns any downstream
row while finalize completes. A mutation that moves prune's endpoint/coverage lock before the fence must
produce the constructed opposing-order `40P01`; the prescribed order must complete without a wait cycle.

### D-H1 -- Durable archive block and source-writer closure

The current `meta_sheets.recovery_writer_state` is state-only and cannot identify an archive builder
or a D5 job. D2 must evolve the canonical writer-block tuple (columns or a single canonical table,
not two independent blockers) to contain at least:

`sheet_id`, closed `state` including `archiving`, `owner_kind`, opaque `owner_id`, bigint-string
`fence`, `lease_until`, and `updated_at`.

Normative transitions:

1. Claim happens only while holding the canonical sheet fence and only from no block, or from an
   expired block that the same transaction CAS-claims by its old owner/fence. Claim increments the
   bigint fence and writes all owner fields atomically. There is no state-only blind reclaim.
2. Every archive capture/job transaction acquires or checks the canonical fence in the order named
   by its protocol, then verifies exact `(owner_kind, owner_id, fence)`, unexpired lease, and allowed
   state before any source read or live write. Stale owners write zero.
3. Heartbeat, pause, cancel, finalize, and release update only with the same exact owner/fence CAS.
   Lease expiry is not permission to clear: a sweeper first CAS-claims a newer fence.
4. `assertNoActiveWriterBlock` remains the single writer entry and recognizes `archiving`; D2 ships a
   mechanical source census plus constructed races proving every writer for `records`, revisions,
   markers, links, config/views, tombstones, auto-number, attachment rows, and physical attachment
   deletion either takes this entry or obeys the generation pin. Missing coverage refuses archive
   creation. Merely setting `MULTITABLE_ENABLE_WRITER_FENCE` without that census is not proof.
5. D2 code and schema land default-OFF. Archive capture itself additionally refuses unless the writer
   fence is exact-ON and the block schema fingerprint is current. This dependency is an enablement
   precondition, not authorization to flip either flag.

### D-H2 -- Exact archive capture snapshot (D2/D3)

An authenticated archive can still be faithfully authenticated **and wrong** if its sections came
from different database states. Hashes and a MAC do not repair a torn capture. V1 therefore only
archives a **head recovery point** created under a durable, owned archive block; it does not
synthesize a new archive for an arbitrary older endpoint from today's live `meta_links`, attachment
rows, or view/config projections. The sealed record operation `E` is only the record/marker component
of that point. The manifest also binds a `source_vector_hash` over the exact links, config,
tombstones, attachments index, auto-number, and schema section heads captured in the same snapshot.

| Fork | Shape |
|---|---|
| **R** | Four phases, one authoritative DB snapshot plus pinned immutable attachment versions. **Claim:** a short `READ COMMITTED` transaction acquires the xact canonical fence as its first statement; only later statements lock the chosen KMS key registry row (`active` required), resolve the current source heads, and CAS-claim a durable `archiving` writer block. It allocates and persists the exact future archive-snapshot operation id plus every required per-section bootstrap operation id/head seq and the parent snapshot seq reservation (D-I0), then inserts the `building` generation and source attachment pin-intents and commits. **DB capture:** only after that commit, a new `REPEATABLE READ` transaction takes its first snapshot, verifies the exact block owner/fence/lease, reserved identity, and pin set, and enumerates every DB section, canonical row order/count, source-vector component, and immutable attachment locator/version/hash into bounded local staging. It performs **zero object-store/network/KMS calls** and does not reacquire the advisory fence. It commits/releases the RR snapshot before attachment bytes are read. **Object capture and crypto reservation:** outside every DB transaction, fetch only the pinned immutable versions and verify size/hash. Obtain/unwrap the generation DEK through the KMS adapter outside a database transaction and derive its KMS-backed `dek_fingerprint`; generate the exact per-section nonces. Before any AEAD encryption, sealing, or upload, a short canonical-fence + key-row + generation/owner CAS transaction rechecks the active key/block/source vector and atomically inserts every immutable `(dek_fingerprint, nonce, generation_id, section_name)` reservation. Any duplicate or failed reservation abandons the build with zero ciphertext. After that transaction commits, encrypt and seal only the reserved generation-scoped objects; missing/drift leaves coverage incomplete. **Finalize:** upload/verify staged AEAD objects, compute the canonical root, and obtain the KMS MAC/signature outside every DB transaction; then use a short transaction in the D-H lock order to recheck block/head/root/source pins/crypto reservations, consume the exact reserved operation ids/seqs, persist the precomputed MAC/signature, create verified archive-object references, transition complete coverage to `verified`, release source pins, and release the block. It makes zero KMS/provider calls. Failure leaves no prune-authorizing generation; unused sequence reservations become ordinary gaps and crypto reservations remain permanent safety tombstones, neither ever reusable identity; the block releases/reclaims only by owner/fence CAS. |
| H2.2 | Read each section in autocommit and trust matching hashes |
| H2.3 | Archive an older endpoint while sourcing links/attachments/config from current live tables |

The crypto-reservation row's shorthand `canonical-fence + key-row + generation/owner CAS` expands to
the D-H order exactly: fence, key row, writer-block owner/fence row, then generation. It does not permit
generation-before-block. Resolving source heads in the claim phase is a non-locking read; any source row
that must be locked follows the same order and is rechecked after the block CAS.

The claim transaction MUST use a source-free lock statement followed by a separate head read. The
forbidden ordering `BEGIN REPEATABLE READ -> wait in pg_advisory_xact_lock -> read head` is proven
stale on PostgreSQL and must have a barrier golden: a writer commits while capture waits; mutation
back to that ordering reads the old head and reds. The durable block is usable only when
`MULTITABLE_ENABLE_WRITER_FENCE` is exact-ON and a source-writer census proves every DB section
writer checks it. Otherwise archive creation refuses before `building`.

The DB-capture transaction may bound memory with cursor/streaming reads, but it may not release its
RR snapshot between DB sections. It holds no advisory fence and performs no attachment HEAD/read,
provider copy, KMS call, or object-store upload. Its bounded output is DB-section bytes plus pinned
immutable attachment descriptors in local generation-scoped staging with a byte/time cap. The block
remains owned across DB capture, object capture, and upload so ordinary writers/deleters cannot
interleave. If head `E`, block ownership, pin ownership, or an immutable attachment version changed,
the generation is abandoned and a new claim is required. Object-store I/O is idempotent and
generation-scoped; orphaned staging objects/source pins are reclaimed only by the
lease/ownership-safe lifecycle rule, while committed crypto reservations are never reclaimed or
reused. No hot prune occurs in claim, capture, object capture, crypto reservation, upload, or
finalize. An uncommitted pin-intent or nonce reservation is never protection.

**Older endpoints:** D4 may restore an already-created archive of an older point. D3 may not create
that archive later unless every section has an independently proven historical authority at that
endpoint. Current terminal link tombstones and current attachment/config projections do not meet
that bar, so the request is `unavailable`, not a best-effort mixed snapshot.

### D-I0 -- Complete section causality and future anchors

The current sealed operation endpoint counts only `meta_record_revisions` and
`meta_record_version_markers`. It is **not** authority for link, config/view, attachment-index, or
auto-number state. Therefore:

1. An archive recovery point is identified by `(E, archive_generation_id, root_hash,
   source_vector_hash)`. `E` alone never selects a full-sheet archive generation.
2. Before D3 may mint any full-sheet archive, and before D5 may claim that a completed restore is a
   future exact whole-sheet anchor, D2 adds one
   append-only, seq-bearing section-history substrate (provisional
   `meta_sheet_section_revisions`) for every non-record section D5 can mutate. Required fields:
   `id`, `sheet_id`, `section_kind`, canonical `entity_key`, `action`, canonical payload or tombstone,
   shared bigint `seq`, and `operation_id`. Writes occur in the same transaction as the live change.
   The closed `section_kind` set also permits `records` only for the internal
   `action='bootstrap_snapshot'` summary below; ordinary record mutations remain in the existing
   record revision/marker tables and cannot be double-emitted as section events.
3. The sealed operation ledger gains closed `operation_kind='ordinary'|'section_bootstrap'|
   'archive_snapshot'|'restore_chunk'|'restore_aggregate'`, `event_contract_version`, and nullable
   `component_count`, with a version-aware database validator. Direct-event kinds (`ordinary`,
   `section_bootstrap`, `restore_chunk`) require `event_count > 0`; count/max cover the union of record revisions, version
   markers, and section revisions for that operation. Legacy record-only endpoints remain readable
   under their old contract but are never relabeled full-sheet Phase-D anchors. The current
   `sealOperation` remains the helper for `ordinary`/`restore_chunk`; a dedicated internal
   `sealSectionBootstrapOperation` requires exactly one `action='bootstrap_snapshot'` section
   revision, no record revision/marker, a closed section kind, and the captured canonical
   `row_count`/`source_hash`. It is not request-callable and cannot represent an ordinary mutation.
   The closed set of **zero-direct-event** kinds is exactly `{archive_snapshot, restore_aggregate}`.
   Neither may have record revisions, markers, or section revisions whose `operation_id` names the
   parent. They use distinct membership tables and distinct dedicated seal helpers/DB-validator branches;
   the generic `sealOperation` and the other kind's helper must refuse them.
4. Link create/delete, config/view changes, attachment-index changes, and auto-number state changed
   by restore must emit section revisions. Omitting any emitted event, forging `event_count`, or
   sealing before the final section event fails at COMMIT. Real-DB mutation goldens cover each kind.
5. D3 refuses a legacy/record-only `E`. Its first current-head archive requires a Phase-D v2
   `archive_snapshot` operation created under the D-H2 finalize fence after section history is
   current. A dedicated immutable membership table (provisional
   `meta_record_history_snapshot_members`) stores `sheet_id`, parent operation id, ordinal,
   `section_kind`, closed source-head kind, nullable source operation id, source head seq, canonical
   row count, and source hash for every **data** section (all required manifest sections except the
   derived `coverage_index`). PK `(sheet_id, parent_operation_id, ordinal)` plus UNIQUE
   `(sheet_id, parent_operation_id, section_kind)` and composite FKs to
   `(sheet_id, operation_id)` prevent cross-sheet/duplicate/omitted members. Both the parent and
   source-operation composite FKs are `DEFERRABLE INITIALLY DEFERRED`, because the dedicated seal
   inserts the parent LAST; COMMIT validates that every referenced operation exists and belongs to
   the same sheet. A nondeferrable parent FK is not an implementation option.

   D2 includes a one-time per-sheet **section-history bootstrap** for populated but quiescent sheets.
   Under the normal D-H2 claim/block/RR capture, it captures every current section, including explicit
   zero-row sections. After the claim owns the block and has resolved the current source heads, that
   same claim transaction allocates one **distinct** `section_bootstrap` operation id and one distinct
   shared-bigint seq for each missing genesis head in exact section order, then allocates one separate
   archive-snapshot operation id and one final `snapshot_seq` for the parent. It persists the exact
   `{section_kind, bootstrap_operation_id, bootstrap_seq}` reservation map plus the parent operation
   id/seq on the `building` generation before commit. The
   parent seq is strictly greater than every captured or reserved source-head seq. These persisted
   values bind the manifest/AAD before upload. At finalize, the transaction rechecks the block/source
   vector and consumes exactly those reservations. For each missing head it inserts one
   `bootstrap_snapshot` section revision and seals its dedicated `section_bootstrap` operation with
   `event_count=1` and `endpoint_seq=bootstrap_seq`; only then does it insert the snapshot membership
   rows and parent archive-snapshot operation LAST. A records section with no legacy sealed endpoint
   uses this same summary-only bootstrap event (`section_kind='records'`, archived row count/hash),
   not a relabeling of old unsealed record events and not a substitute for record replay. The
   bootstrap and archive
   snapshot commit atomically or leave the per-sheet bootstrap state `uninitialized`; partial genesis
   heads cannot become current. Claim/build failure may leave gaps in the sequence but may never reuse
   a reservation or publish a row for an abandoned generation.

   The snapshot operation has no direct live mutation events: `event_count=0`, `component_count`
   equals the exact data-section member count, and `endpoint_seq=snapshot_seq`, which is strictly greater
   than every captured or reserved source head. A new `sealArchiveSnapshotOperation` invokes the
   dedicated per-head bootstrap seals, inserts memberships, then inserts the snapshot parent LAST;
   the version-aware DB trigger recomputes the exact section
   set/count/hash bindings and is one of exactly two zero-direct-event operation contracts. Its stored
   `event_count` is exactly zero. The current `sealOperation`
   cannot mint it. A stale source vector, incomplete bootstrap, or writer not joined to D-I0 refuses.
   This is a new current-head anchor, never a retroactive relabel of a legacy endpoint.
6. A chunk endpoint of an `abandoned_partial` job is internal evidence only. APIs/catalog never
   advertise it as a completed whole-sheet restore. A successful multi-chunk job creates a separate
   aggregate terminal operation under the still-owned writer block; the last chunk itself is **not**
   the aggregate anchor. Provisional immutable membership table
   `meta_record_history_operation_members(sheet_id, parent_operation_id, ordinal,
   child_operation_id, child_endpoint_seq, child_event_count)` has PK
   `(sheet_id, parent_operation_id, ordinal)`, UNIQUE
   `(sheet_id, parent_operation_id, child_operation_id)`, and composite parent/child FKs to
   `(sheet_id, operation_id)`. All rows bind one sheet/job; ordinals are contiguous; every child is
   already sealed; stored child count/endpoint equals its sealed row.
7. A v2 `restore_aggregate` is the second and only other zero-direct-event contract and cannot use
   `sealOperation` or `sealArchiveSnapshotOperation`. A dedicated
   `sealRestoreAggregateOperation` inserts the ordered child memberships then the parent LAST under
   the canonical fence. Its version-aware DB branch requires `component_count` to equal all
   successful job chunks, stored cumulative `event_count` to equal the exact checked integer sum of
   child events (even though the parent owns zero direct event rows), and
   `endpoint_seq` to equal the exact max child endpoint; each child must already be an immutable
   `restore_chunk` for the same sheet/job, and the membership set must equal the committed receipt
   set. No unlisted committed chunk or duplicate child may exist. Because the durable block excludes
   interleaving sheet writers, floor-aware replay through that endpoint contains every chunk. The
   aggregate is the sole `terminal_operation_id` advertised for a `done` job. Removing one member,
   pointing at a foreign sheet/job, bypassing either dedicated seal helper, or treating the last
   chunk as terminal must red a real-DB golden.

### D-I -- D4 is the single reconstruction authority

| Fork | Shape |
|---|---|
| **R** | One D4 reader returns the complete section state used by preview/apply hashes. Record feeder after the §1.4 correction: (1) hot floor-aware replay `trusted_since_seq < seq <= anchorSeq`, (2) `composeBaselineOverlay` for keys still absent, (3) **archived** record bytes no longer hot. Link/config/attachment/auto-number feeders use the D-I0 section history or the selected archive generation/root, never current live projections for an older point. Classifier remains `classifyExactAnchorRecoveryPlan`. `reconstructRecordsAtT` stays display-only. Current `reconstructRecordsAtSeq` (`seq <= anchor`, no floor) is **not** the D4 primitive. |
| I2 | A second archive-only reconstructor with a different record state type |
| I3 | Use wall-clock reconstruction, or current unbounded `seq <= anchor` replay, when hot seqs are gone |

I3 reopens P1-A/P2-B and the discovered P1. I2 splits WYSIWYG. D5/D6 **consume** D4; they do not
re-derive existence from trash or from terminal tombstones. D4 must not merge until the §1.4
correction has real-DB/mutation evidence.

**Inbound links:** archiving `meta_link_tombstones` does **not** create at-anchor inbound authority.
V1 restore of deleted records (plan `resurrects`) stays `INBOUND_UNPROVABLE` until a separate inbound
lock exists. Reusable #4446 mechanics apply only after that lock. Field-value undelete from archived
`meta_field_value_tombstones` keyed by `config_revision_id` is a **different** vintage question and
is still out of D1 runtime.

### D-J -- Preview, live drift, permissions

| Fork | Shape |
|---|---|
| **R** | Extend the current signed identity: add `archiveGenerationId` + archive `rootHash` to the claims (new token `type` or versioned claim set so pre-archive tokens cannot drive archive restore). Execute re-verifies generation, root hash, in-fence live/schema/link hashes, full-table-read (`hashRecoveryAuthorizationScope`), and selected conflict policy. Drift / permission revoke / schema drift / locked records / retention-floor drift / expired-or-wrong-key archive => zero writes (or the **explicitly selected** conflict policy once D5 names one). V1 default = refuse. |
| J2 | Archive root hash only; skip live-set binding |
| J3 | Allow partial apply on schema-drift (superseded by 2026-07-17 P1-2: whole-refuse) |

Permission **policy** is not restored (D-N). Permission **evidence** may be in the audit section.

### D-K -- Async job-level claim vs token burn

| Fork | Shape |
|---|---|
| **R** | Two different mechanisms. (1) **Token burn** (`meta_recovery_token_burns`): at-most-once accept of a signed preview. Burn happens in the same transaction that inserts the durable job (or that commits a sync L8 apply). Replay of the JWT cannot start a second job. (2) **Job claim:** `FOR UPDATE SKIP LOCKED` + fence-CAS lease, bigint fence as **string**, values-free failure reasons -- pattern from `automation-durable-dispatcher.ts`, **not** a reuse of that table. Worker crash retries the **job**, never re-burns the token. Completed chunk cannot double-apply. |
| K2 | Burn the token on every chunk |
| K3 | Skip token burn for async; job id is enough |

K2 turns a crash after N chunks into a stuck token. K3 loses the signed preview binding (mode,
scope, generation). Do not import `workflow-job-contract.ts` as if it were wired.

**Normative D5 schema contract** (names provisional; fields/constraints are not):

- `meta_recovery_archive_jobs`: `id uuid` PK; non-NULL workspace/base/sheet/actor identity;
  `token_sha256` UNIQUE; mode; archive generation/root/source-vector; immutable `plan_hash` and
  ordered-scope/chunk-plan object identity; closed state
  `planned|applying|paused_retryable|done|abandoned_partial|cancelled_zero_write`; decimal-string
  total/completed counts; immutable bigint `block_fence`; `worker_owner_id`, independent bigint
  `worker_fence`, `lease_until`, `resume_deadline`, nullable `terminal_operation_id`, timestamps. A
  CHECK requires terminal operation only for `done` and completed count <= total.
- `meta_recovery_archive_job_chunks`: PK `(job_id, chunk_index)`; immutable `chunk_hash`, state,
  nullable operation id/endpoint seq, committed count, and committed timestamp. A successful receipt
  is inserted in the same transaction as its live writes and sealed endpoint.
- Frozen plan objects are immutable and root-bound; job rows never store raw preview tokens or
  recovered customer values. `token_sha256` is the acceptance idempotency key.
- D5 extends `meta_recovery_token_burns` (or adds a one-to-one companion keyed by its existing
  `token_sha256`) with closed `burn_kind='sync'|'async'`, nullable UNIQUE `job_id`, nullable UNIQUE
  `sync_operation_id`, non-NULL archive-generation/root binding, non-NULL `token_expires_at`,
  non-NULL `retain_until`, nullable `terminal_at`, and row-version/fence metadata for deletion CAS.
  New rows satisfy exactly one closed shape: `sync` requires `job_id IS NULL`, a sealed
  `sync_operation_id`, and non-NULL `terminal_at`; `async` requires non-NULL `job_id`,
  `sync_operation_id IS NULL`, and permits NULL `terminal_at` only while the job is nonterminal.
  The sync L8 transaction inserts the burn and sealed operation/audit binding and sets
  `terminal_at` atomically with the live writes. The async accept transaction inserts the burn, job,
  and binding atomically; only the job's terminal-state transaction sets `terminal_at`. Existing
  burns that lack this provenance are **never auto-pruned**; no kind, timestamp, or operation is
  guessed or backfilled from `burned_at`.

Required owner-scoped APIs: preview (existing policy), accept/status, bounded resume, and cancel.
Status/resume/cancel require the same workspace/base/sheet/actor authority as preview plus exact job
identity; cross-tenant and actor mismatch are existence-hidden. Claim uses
`FOR UPDATE SKIP LOCKED` only to select work. While holding the canonical sheet fence, it CASes the
job's `(worker_owner_id, worker_fence, lease_until)` but does **not** rewrite the durable writer
block. That block remains `(owner_kind='restore_job', owner_id=job_id, fence=block_fence)` from accept
through release. Every chunk checks both the immutable block tuple and the current worker-lease tuple
in the same transaction; a stale worker or changed block writes zero. No endpoint accepts an
arbitrary worker owner/fence from request input.

Sync restores below the ceiling stay on L8 one-txn apply + burn, no job table required.

### D-K2 -- Async restore transaction and partial-completion contract

Above 5000 records, V1 is **chunk-atomic, not whole-job atomic**. The word "resume" never means
replaying a burned token or recomputing a mutable plan.

1. **Accept once:** under the canonical fence, execute rechecks the signed preview, archive
   generation/root, current permissions, schema and live hashes; then burns the token, inserts the
   immutable frozen plan, and commits the D-H1 durable writer-block owned by exact
   `('restore_job', job_id, block_fence)` in one transaction. `block_fence` and the separately minted
   initial `worker_fence` are stored atomically but are not interchangeable.
   Plan identity includes ordered scope, per-record expected live version, target hash, mode,
   archive generation/root, schema/link/live hashes, and deterministic chunk boundaries.
2. **Block interleaving writers:** while state is `applying` or bounded `paused_retryable`, the
   durable writer block remains active. Every chunk transaction reacquires the canonical sheet
   fence, verifies exact `(job_id, block_fence)` on the active block plus exact
   `(worker_owner_id, worker_fence, lease_until)` on the job lease, and performs a DB-fresh
   full-read/authority check before any record write. A worker never holds the database
   fence while downloading unverified archive bytes; it AEAD/MAC-verifies and materializes the
   frozen chunk first, then rebinds its root/chunk hash inside the transaction.
3. **Commit receipt with data:** a chunk is deterministic and all-or-nothing. Its record revisions,
   link writes, one sealed chunk operation, and `(job_id, chunk_index)` completion receipt commit in
   the same transaction. Retry sees the receipt and skips; a stale fence-CAS worker writes zero.
   Each non-empty chunk has its own operation id. Successful finalization creates and seals the
   distinct D-I0 aggregate operation over the exact ordered receipt set; only that aggregate id is
   recorded as `terminal_operation_id` and may become the future exact anchor.
4. **Failure states:** transient infrastructure failure may enter `paused_retryable` only until a
   bounded `resume_deadline`, retaining the writer block. Permission revoke, archive/root/key drift,
   schema/live-version drift, lock conflict, explicit cancellation after any completed chunk, or
   deadline expiry enters `abandoned_partial`, releases the block, and performs no later chunk.
   Automatic resume is forbidden from `abandoned_partial`; a new preview/token is required for any
   remaining scope. Cancellation before the first committed chunk is `cancelled_zero_write`.
5. **Honest visibility:** completed chunks remain committed after `abandoned_partial`; they are not
   rolled back or called a successful whole-sheet restore. UI/catalog expose counts and state, while
   ordinary logs remain values-free. A partially completed job has no advertised completed-restore
   anchor even though each committed chunk has an internal sealed endpoint.

Rejected shapes: releasing the writer block between resumable chunks, re-reading current live state
to silently rewrite the frozen plan, one unsealed operation spanning committed transactions, a
receipt committed separately from its writes, or automatic continuation after authorization/drift
failure.

**Burn lifetime and current-path replacement:** current main already invokes the age-only global
`pruneExpiredRecoveryTokenBurns` best-effort after a successful recovery. D5 must retire that caller
and replace the function in the **same PR** that adds the binding schema; leaving either old
`DELETE ... WHERE burned_at < ...` path callable is a merge-blocking mutation. The replacement may
delete only provenance-complete burns under the rules below. Existing provenance-NULL burns are
retained, not fed to the legacy age-only delete. For a new **sync** burn, the committing L8
transaction sets `terminal_at` and `retain_until >= max(token_expires_at, terminal_at +
audited_replay_horizon)`. For a new **async** burn, accept sets `retain_until >=
max(token_expires_at, resume_deadline)` and its terminal transition extends it to at least
`terminal_at + audited_replay_horizon`.

Deletion is kind-specific and fail-closed. Both shapes require, in one transaction, the exact burn
row-version, `now >= retain_until`, no active legal hold on the bound generation, and complete
provenance. A sync burn additionally requires `job_id IS NULL`, a still-sealed committed
`sync_operation_id`, its matching audit receipt, and non-NULL `terminal_at`. An async burn requires
the bound job to be terminal with matching `terminal_at` and no nonterminal reference. A generic
"job_id is NULL" or age-only predicate is forbidden. The referenced operation/job and audit receipt
outlive the burn or are deleted atomically with it so replay can never observe "burn absent,
accepted execution forgotten." Existing provenance-NULL burns and any failed/ambiguous check are
retained. Separate sync and async mutation goldens must each prove that early deletion makes a replay
attempt reachable and reds the at-most-once contract.

### D-L -- Lifecycle / sweep

| Fork | Shape |
|---|---|
| **R** | Separate recovery-horizon sweeper. Transition `verified -> expired` only after `expires_at` and only when no legal hold applies. **Object deletion requires payload state `expired`** and is a second owner-audited intent/receipt protocol; catalog `superseded_by_generation_id` is only a candidate-selection hint and never authorizes deletion. Deletion is **refused** under legal hold, while this generation is the sole complete coverage for any still-legal recovery point, while any nonterminal D5 job binds it, or while key rotation lacks a verified complete replacement. Expiring an archive **never** implies hot prune or object deletion. Token-burn prune obeys D-K2 job lifetime and is otherwise separate. |
| L2 | Couple archive expiry to `MULTITABLE_META_REVISION_RETENTION_*` |
| L3 | Delete verified objects without an expired state, or delete the last covering generation of a still-legal point |

L2 collapses the two horizons §12.1 split. L3 removes the auditable deletion and can make a still-legal
anchor `unavailable` without a replacement archive. A newer verified generation that covers the same
point may allow the old generation to expire after its horizon and then become deletion-eligible; the
last cover may not. Supersession before expiry changes neither payload state nor deletion authority.

For V1, a **still-legal recovery point** is a cataloged exact identity
`(workspace_id, base_id, sheet_id, anchorOperationId, anchorSeq, checkpointId)` whose recovery
horizon has not expired and which has not been explicitly owner-deleted, plus any generation bound
by a nonterminal D5 job. "Another cover" means a different `verified`, nonexpired generation with
that exact identity and complete section/attachment availability; a later anchor, a best-effort
archive, or a merely `building` generation is not a replacement.

**Normative external-object deletion protocol:** D3 adds
`meta_recovery_archive_object_deletions` (name provisional) with `id uuid` PK; non-NULL
`generation_id` plus an opaque catalog object id (never a URI); closed
`state='requested'|'ready'|'deleting'|'deleted'|'failed_retryable'|'cancelled'`; owner request id,
worker owner/fence, nullable `lease_until`, one immutable opaque provider idempotency key, bigint row
version, attempt count, timestamps, and a values-free provider receipt digest only after confirmed
deletion. UNIQUE `(generation_id, object_id)` prevents two deletion state machines for one object.

The prepare transaction locks the expired generation, its active-hold row, exact object reference,
bound nonterminal jobs, replacement-coverage rows, and key registry/reference in the D-L order. It
requires `state='expired'`, proves every refusal condition above, and CASes the intent to `ready`;
unknown or failed checks roll back. A worker transaction locks the same generation and intent,
rechecks the refusal set, and CASes `ready|failed_retryable -> deleting` before committing. Only then
may it call the object provider outside every database transaction. Provider success is recorded in
a second transaction as `deleted` with the receipt digest, and only that transaction releases the
generation's `archive_object` reference and key reference. Failure records `failed_retryable` and
retains both references. No sweeper infers success from ENOENT without the backend's locked
idempotency contract and receipt rule.

`deleting` is a leased, recoverable claim, not a terminal limbo. After `lease_until`, a successor uses
the same D-L lock prefix and CASes exact `(state='deleting', worker_fence=N, lease_until<db_now,
row_version=V)` to a greater worker fence and lease. It **must reuse** the stored provider idempotency
key; minting a new external operation is forbidden. Outside the transaction it first reconciles the
provider operation. Confirmed deletion (including provider-specific already-absent only when bound to
that same operation key and a verifiable receipt) goes through the normal `deleted` receipt
transaction. A confirmed not-accepted/definite retryable failure may CAS to `failed_retryable` while
retaining references. Timeout, lost response, or unknown provider state remains `deleting`; it is
reclaimable after the new lease and is never converted to success or ordinary retry from absence
alone. D3 may support a provider only if its adapter supplies idempotent delete plus status/receipt
reconciliation under this stable key. Crash-before-call, crash-after-provider-accept, and
crash-after-delete-before-receipt goldens each expire the lease, transfer ownership, and converge to
one external deletion and one `deleted` receipt. Mutations that remove lease expiry/CAS, rotate the
idempotency key, or release references before the receipt must red.

Legal-hold placement uses the same generation lock. If it wins before `deleting`, it cancels a
`requested|ready|failed_retryable` intent and inserts the hold atomically. If deletion already owns
`deleting` or `deleted`, hold placement refuses explicitly; it must not claim to protect an external
object whose deletion has already crossed the durable point of no return. A deletion retry must pass
the hold check again. Mutation goldens race hold placement at `ready -> deleting` and prove exactly
one side wins; external delete is unreachable when the hold wins.

**Normative hold schema and transitions:** D3 adds
`meta_recovery_archive_legal_holds` (name provisional) with `id uuid` PK; non-NULL
`workspace_id`, `base_id`, `sheet_id`, `generation_id`; closed `state='active'|'released'`;
values-free `reason_code`; `placed_by_actor_id`, `placed_at`; nullable `released_by_actor_id`,
`released_at`; and bigint `row_version`. A partial unique constraint permits at most one active hold
per generation. Place and release require the same owner/tenant authority as archive deletion.
Release is one CAS from `(state='active', row_version=N)` to `released`; it never deletes the audit
row. A hold becomes effective in the same transaction that locks the generation and inserts the
active row. Every expiry, object deletion, `archive_object` reference removal, bound-job burn
removal, and key-destruction
decision follows the D-L order: canonical sheet fence when sheet-scoped, key row when applicable,
generation, then job/hold/object rows in bytewise id order. It locks/rechecks the active-hold row in
that transaction before its destructive CAS. Hold placement uses the same prefix, so a concurrent
place wins or makes the destructive CAS affect zero rows; no path locks an object/deletion intent and
then reaches backward for generation or key. A denormalized boolean or stale catalog read is not
authority.

An active hold blocks archive expiry, object deletion, `archive_object` reference removal,
token-burn removal for jobs bound
to that generation, and KMS key destruction. If V1 ships no hold-management UI, those destructive
paths remain unavailable except through the owner-authorized API/ops surface above; absence of UI is
not permission to ignore an imported hold. Ordinary logs expose only code/state/count, never
`reason_code` text or identity values.

**KMS reference and destruction protocol:** D3 owns one normalized key registry row per `key_id` with
closed state `active|retiring|destroyed` and bigint row version. Every `building`, `verified`,
abandoned-but-not-cleaned, or not-yet-object-deleted generation, every generation-scoped staging
object/pin, and every nonterminal D5 job stores the exact `key_id` reference until its object is
confirmed deleted/absent. Every new generation/job/reference acquisition requires
`state='active'`; a sheet-scoped writer takes the canonical sheet fence first, then the key registry
row, before any generation/job/object row. Staging objects and pins inherit the generation key and
cannot silently switch it.

D3 also adds an audited key-destruction intent with `key_id`, closed
`state='requested'|'ready'|'destroying'|'destroyed'|'failed_retryable'`, opaque owner request id,
worker owner/fence, nullable `lease_until`, attempt count, one immutable opaque KMS operation
idempotency key, values-free receipt digest, timestamps, and bigint row version. The owner request does not call KMS. A short database transaction
locks the key registry row, CASes it `active->retiring`, locks/CASes the intent, and proves **zero**
references across archive generations, staging objects/pins, nonterminal jobs, and active legal
holds; any unknown/failed query rolls back both transitions. Committing `retiring+ready` prevents a
new reference from entering after the zero-reference check. A worker CASes
`ready|failed_retryable -> destroying`,
commits, performs the idempotent external KMS delete **outside** every database transaction, and in a
second transaction records both key and intent `destroyed` only after provider confirmation (or
`failed_retryable` after a definite not-accepted/retryable failure while the key stays `retiring`).
Rechecking the locked registry state and zero references is required before every retry. Reopening
`retiring->active` is a separate owner CAS and requires provider proof that deletion did not occur.
Archive/object sweep never creates or executes this intent implicitly.

`destroying` uses the same durable recovery rule as object deletion. On lease expiry, a successor
locks the retiring key first, re-proves zero references/holds, and CASes the exact stale worker fence,
lease, and row version to a new owner/fence/lease. It reuses the stored KMS operation idempotency key
and performs status reconciliation or the idempotent delete outside every database transaction.
Confirmed deletion plus a verifiable receipt is the only transition to `destroyed`; an ambiguous
timeout/lost response stays `destroying` for another fenced reconciliation, while a definite
not-accepted failure may become `failed_retryable`. A provider without stable idempotency and
status/receipt reconciliation cannot implement D3 key destruction. Real-DB/fake-KMS crash goldens
cover crash-before-call, accepted-delete-before-response, and delete-confirmed-before-DB-finalize;
all must transfer the expired lease and converge to one KMS destruction receipt. Removing stale-lease
takeover, changing the operation key, marking `destroyed` from not-found without operation-bound
receipt, or admitting a new reference while the key is `retiring` must red.

The authoritative order is: canonical sheet fences in sheet-id order (when the path is sheet-scoped),
then key registry rows in key-id order, then the writer-block row when the path uses one, then generation
ids, job ids, hold ids, and object/pin ids in
bytewise id order. KMS destruction is not sheet-scoped: it takes key rows first and **never** requests
a sheet fence. Build cleanup may not lock a generation and then request its key row. A constructed
claim-versus-key-retirement race must show either the claim commits its reference before retirement,
or retirement commits `retiring` and the claim writes zero; no reference may appear after `ready`.
Real-DB opposing-order goldens must produce a detectable deadlock under mutation and no wait cycle
under the prescribed order.

### D-M -- Audit catalog vs ordinary logs (values-free)

Two surfaces. Do not collapse them.

| Surface | May contain | Must not contain |
|---|---|---|
| **Access-controlled audit catalog** (provisional `meta_recovery_archives` / job rows; same authz bar as recovery preview, not an ordinary log sink) | Identity fields needed to bind and operate: workspace_id, base_id, sheet_id, actor_id, generation_id, hashes, key_id (not raw keys), expires_at | Recovered field values, attachment bytes, raw tokens, URIs, credentials, host/IP/password, authorityCode/appKey |
| **Ordinary logs and metrics** (v3.7 §12.3; AGENTS.md values-free) | `state`, refusal/success **code**, **count**, `format_version`, **section** name, and -- if a correlator is required -- an **opaque non-customer digest** (server-keyed HMAC of catalog identity, not reversible from logs) | workspace_id, base_id, sheet_id, actor_id, generation_id, job id, hashes of customer content, URIs, keys, recovered values |

| Fork | Shape |
|---|---|
| **R** | Split above. Ordinary logs never echo catalog identity fields. |
| M2 | Log object URIs or workspace/base/sheet/actor ids on the ordinary log path "for debug" |
| M3 | Log recovered payloads on restore failure |

M2/M3 violate v3.7 §12.3 and AGENTS.md. `meta_recovery_token_burns` already stores token **sha256**
plus sheet/actor in a **table**, not in logs (`zzzz20260719120000_create_meta_recovery_token_burns.ts:13-15`);
Phase D must not start logging those identity columns.

### D-N -- V1 exclusions (non-goals as decisions)

| Item | V1 ruling |
|---|---|
| Cross-sheet / base-wide atomic restore | Out. Per-sheet sealed operations only (v3.7 §1.2 last bullet). |
| Permission policy restore | Out. Evidence optional; live grants untouched. |
| Resurrect / inbound-at-anchor | Out until a dedicated inbound lock. Archive may still **store** link tombstones. |
| Recovery of pre-archive / pre-capture bytes | Out. `unavailable`. |
| Wall-clock destructive archive restore | Out. |
| System sheets in `SYSTEM_SHEET_KINDS` | Out of v1 archive/restore. |
| Reconsider `RESET_RETENTION_CONFLICT` | Out of D1-D7 until owner reopens after D7 evidence. |
| E1 / L2+ / production flags | Out. |

## 4. Decision table (recommended fork vs rejected)

| ID | Question | Recommended | Rejected |
|---|---|---|---|
| D-A | Manifest bytes | Canonical JSON + `format_version` | Pretty JSON; protobuf-as-v1-authority |
| D-B | SM | Payload `building->verified->expired`; catalog build attempt `active->finalized|abandoned`; owner/fence cleanup; new generation on correction | In-place rewrite; failed building row with no terminal cleanup state |
| D-C | Binding | workspace_id + base_id + sheet_id + exact anchor + checkpoint + generation + `created_at` (catalog/MAC) | sheet-only; invented tenant table |
| D-D | Integrity | Plaintext SHA-256 sections; root-bound exact row counts; `root_hash` = SHA-256(body excluding root/MAC); KMS MAC over domain-sep + root + binding (incl. `created_at`); seq decimal string | Unkeyed hash as sole authority (D-D.3); required Merkle in v1 (D-D.2); hashing a manifest that already contains `root_hash` |
| D-E | Storage | Neutral adapter; local = test/staging unless durable+separate domain | Vendor-hardwire; hot-DB bytea; same-host files as production archive |
| D-F | Crypto | AEAD sections + KMS manifest MAC; KMS-backed opaque DEK identity; globally unique `(dek_fingerprint, nonce)`; every KMS call outside DB transactions; rotation = new generation | Disk-only; hash-only; wrapped-blob hash as DEK identity; same-DEK nonce reuse; KMS under DB locks; client keys in v1 |
| D-G | Attachments | Every deleter honors owner/fence pin; immutable source version -> sealed staging -> archive; missing/drift = incomplete and never verified | URI-only; cooperative sweep only; mutable source read; inline blobs |
| D-H | Prune | Verified archive first (incl. attachments); exact id+hash per candidate; config/tombstone evidence shares a deferred operation id with its section event; whole-operation prune proves endpoint plus every child in one D-H-ordered transaction; else hot rows stay | Endpoint-only coverage; row-level prune of operation evidence; prune-then-archive; best-effort |
| D-H1 | Writer closure | Job/generation-owned durable block with bigint fence/lease/CAS; exact writer census; writer-fence ON is a runtime prerequisite | State-only blind reclaim; assuming default-OFF fence excludes writers |
| D-H2 | Capture consistency | READ COMMITTED fence-first claim -> committed durable block -> RR source snapshot -> pre-encryption durable DEK/nonce reservation -> sealed staging -> out-of-txn upload -> short CAS finalize | RR wait-on-xact-fence stale snapshot; encrypt/upload before nonce reservation; long network I/O under advisory fence; current-live projections for an older endpoint |
| D-I0 | Complete causality | Seq/operation-bound section revisions plus versioned, kind-specific DB validators; one reserved/sealed `section_bootstrap` operation per missing genesis head; dedicated membership+seal for snapshot/aggregate; only done aggregate endpoint is a full-sheet restore anchor | Bind genesis events to the zero-direct-event parent; omit deferred parent FK; reuse direct `sealOperation` for zero-direct-event synthetic anchors; call a record-only/last-chunk endpoint full-sheet |
| D-I | Reconstruct | Single D4 section state on **floor-aware** replay + overlay + archive/section history | Current unbounded `seq <= anchor`; current live non-record sections; second reconstructor; wall-clock |
| D-J | Preview | Extend signed identity with generation/root | Skip live hash; partial schema-drift apply |
| D-K | At-most-once | Closed sync/async burn shapes; sync binds sealed operation, async binds job at accept; job fence-CAS for workers | Generic nullable-job burn; per-chunk burn; job-id-only |
| D-K2 | Async semantics | Normative job/chunk schema; immutable job block fence distinct from worker lease fence; deterministic receipts; replace current age-only burn pruner; kind-specific sync/async prune; burn retained through terminal; explicit `abandoned_partial` | Interleaved writers; conflated block/worker fence; mutable plan; state-only reclaim; legacy/early/generic jobless burn prune; silent whole-job claim |
| D-L | Lifecycle | Independent horizon + normalized legal-hold CAS; expired-only object deletion intent/receipt; key registry `active->retiring` prevents new refs before external delete; no delete/key destruction of sole complete cover or running-job bind | Supersession as deletion authority; boolean hold authority; zero-ref check without reference-admission lock; couple to hot retention; delete last cover; implicit KMS deletion |
| D-M | Logs | Ordinary: state/code/count/format/section + optional opaque digest. Identities stay in access-controlled catalog | Ordinary logs of workspace/base/sheet/actor; URIs; keys; recovered values |
| D-N | Scope | Single-sheet data restore | Cross-sheet txn; permission restore; silent resurrect |

## 5. Dependency-ordered D2-D7 slices

Estimates from v3.7 §12.5. Merges remain serial on then-current `main` with exact-head review.
Drafting may be parallel where file ownership does not collide. **No slice is authorized by D1
status PROPOSED.** After this lock is RATIFIED, slices are still default-off.

| Slice | Depends on | Deliverable | Must not |
|---|---|---|---|
| **D2** archive writer + SM + prune handoff | D1 RATIFIED; Phase B on `main`; **§1.4 P1 floor correction landed**; writer-fence code/coverage landed | Adapter + closed catalog/manifest schema + D-H1 owned block + source-writer/deleter census + D-I0 seq-bearing section-history schema/writer coverage + nullable/deferred operation binding for config/tombstone evidence + one-time populated/quiescent-sheet bootstrap with distinct `section_bootstrap` operations and deferred membership FKs + version-aware v2 snapshot/aggregate validators and dedicated seals + D-H2 safe claim/capture/pre-encryption crypto reservation/stage/out-of-txn MAC/finalize + build-attempt terminal cleanup + root/count/source-vector + distinct source pins/archive-object refs + AEAD/MAC with zero KMS calls in DB transactions + permanent DEK/nonce reservation + complete-only `building->verified` + root-bound immutable coverage index + exact-id/hash relation + row-level `operation_id IS NULL` exclusion + D-H-ordered all-child whole-operation prune gate; flag default-off and registered | Flip retention/fence ON; use RR-before-xact-fence; encrypt/upload before nonce reservation; KMS/network upload under DB/advisory locks; archive older endpoint from current projections; relabel a record-only endpoint; bind genesis to the zero-direct-event parent; leave failed builds ownerless; relax conflict; forge post-verify coverage; prune operation children individually; prune incomplete/building |
| **D3** scheduled/manual recovery-point catalog + lifecycle + verifier | D2; **D-I0 v2 section history + `archive_snapshot` validator** | Create a current-head generation only from a newly sealed v2 `archive_snapshot` that binds every required section head/count/hash; refuse legacy/record-only endpoints; list/get; MAC/tag/count verifier; normalized legal-hold CAS; key registry/reference-admission lock; expiry plus expired-only object-deletion intent/receipt plus two-phase key-deletion intents; leased owner/fence takeover of stale `deleting`/`destroying` with one immutable provider idempotency key and receipt reconciliation; ordinary logs values-free | Create arbitrary older archive without historical section authority; relabel a record-only endpoint; delete a merely superseded verified generation; archive system sheets; zero-ref check without retiring key; automatic KMS/object delete; unrecoverable provider mid-state; log identities |
| **D4** reconstruction from checkpoint + archived delta | D2, D3, **§1.4 floor-aware replay+strict**, D-I0 section revisions | Single complete-section reader at selected generation/root: record replay `trusted_since_seq < seq <= anchorSeq` + overlay + archived bytes; non-record sections from section history/archive; >2^53 seq and delete/recreate generations | Call `reconstructRecordsAtT`; use current `seq <= anchor`; source old point from current links/config/attachments; lift `INBOUND_UNPROVABLE` |
| **D5** restore planner + async bulk | D4; L8 apply as sync kernel; D-I0 v2 chunk **and aggregate** operation validator | Three modes; preview identity + generation/root/source-vector; sync <= ceiling; normative job/chunk/burn-binding schema with closed sync/async shapes; immutable block fence distinct from worker lease fence; replace the existing age-only burn prune caller with kind-specific predicates; frozen chunks + atomic receipts + section revisions + sealed operation per chunk; a successful multi-chunk job seals one aggregate over the exact ordered receipt set and advertises only that aggregate as `terminal_operation_id`; `source='restore'` | Permission overwrite; cross-sheet txn; interleaved writers; state-only reclaim; legacy/early/generic jobless burn prune; mutable resume; double-apply; last chunk or partial endpoint called full success |
| **D6** Time Machine picker / diff / scope / progress UI | D5 contracts | Preview-first UX; no wall-clock execute; progress/retry; values-free errors | Ship a live execute control while flags OFF that looks enabled |
| **D7** staging fault/scale/runbook + development+verification MD | D2-D6 merged default-off | Mutation-proven §12.6 matrix; runbook; **still no production enablement** | Treat D7 MD as runtime proof of production recoverability |

File-ownership hint (not exclusive): the §1.4 floor correction owns
`reconstructRecordsAtSeq` / strict-precheck SQL (separate from D2). D2/D3 touch retention + new
catalog + AEAD/MAC verify. D4 consumes the corrected compose seam and archived sections -- it
must not fork a third reconstructor. D5 touches execute/route/caps; D6 `apps/web`; D7 tests +
`docs/development`. Approval FWB and automation outbox are **coordination** surfaces (§6), not D2
owners.

## 6. Approval / automation shared-write coordination map

Phase D restore is another fenced sheet writer. It must not invent a second lock order.

| Peer | Shared bytes | Coordination rule (v1) |
|---|---|---|
| Exact-anchor L8 apply | `meta_records`, `meta_links`, revisions, ledger, `recovery_writer_state` | D5 sync **is** L8 (or a strict superset that keeps fence-all-sheets-then-rows-NOWAIT + authority leases). Do not run a second apply kernel. |
| Ordinary / plugin record writes | same | Observe `fenceWriterEntry` + writer block (`canonical-sheet-fence.ts:167-188`). |
| Derived formula/lookup/rollup | `meta_records.data` keys, no revision | Keep `applyFencedDerivedDataMerge`; restore recomputes after data restore rather than trusting archived derived bytes. |
| Approval form writeback | bound `meta_records` | FWB execute already rechecks the bound record. A restore in `applying` must block FWB via the durable writer block; FWB must not write through a stale bind. Archive of an approval **projection** sheet is out (D-C). |
| Automation executor + durable outbox | record writes; `meta_automation_outbox_consumer` | Outbox claim (SKIP LOCKED + fence-CAS) is **not** the recovery job table. Recovery jobs copy the **pattern**, not the rows. Automation must see the writer block. |
| Tombstone capture | tombstone tables | Capture flag remains independent. Archive stores whatever was captured; it does not backfill uncaptured history. |
| Attachment cleanup / blob purge | `multitable_attachments` + files | D2 source pin-intent is an exclusion set **before** blob read; verified archive copies use a separate `archive_object` reference (D-G). Source sweeps skip active source pins; archive deletion obeys the D-L expired-only intent/receipt. Until D2, current sweeps are unchanged (flag-off byte parity). |
| Config uncreate/undelete / permission-revert | config revisions; grants | Orthogonal flags (`global-history-flag-manifest.mjs`). D5 must not call permission-revert. |
| History retention sweeps | hot logs | D-H handoff; same process, new precondition. |
| O-2 authority triggers | platform permission tables | Restore does not ENABLE triggers. Recovery still fail-closes if the trust pair / substrate is unarmed. |

If two isolated implementation lanes are used (v3.7 §12.5), they split **D2/D3** vs **D4/D5** only
after a written file-ownership list. They do not both edit `exact-anchor-recovery-execute.ts`.

## 7. Acceptance matrix (design bar for later slices)

D1 itself has **no runtime tests**. The matrix is what D2-D7 must mutation-prove before anyone may
claim post-retention recoverability. Distinctions: **design evidence** (this file) != **implementation
evidence** (goldens on an exact head) != **enablement evidence** (owner/ops).

| Class | Must show | Must remain |
|---|---|---|
| **Migration** | Fresh-DB up/down/replay for any new catalog; no rename of existing history tables; zzzz order after current recovery migrations. Development `down()` on a nonempty Phase-D catalog refuses and never deletes external objects/pins/jobs. | Flag-off: zero new writes from archive code; production rollback never uses destructive migration-down |
| **Real-DB** | Archive write + AEAD+MAC verify; exact format section set/order/envelope/entity keys and recomputed decimal counts; writer commits while an RR capture waits on an xact fence => old unsafe order demonstrably stale, while D-H2 claim/block/RR order captures current source vector; every source writer/deleter coverage arm; a populated but quiescent pre-D2 sheet bootstraps all data sections (including explicit zero-row sections) using one distinct sealed `section_bootstrap` operation per missing head plus a parent-last `archive_snapshot`, with deferred composite FKs valid at COMMIT; older-endpoint/current-section mix and record-only D3 endpoint refused; prune joins each exact source id and canonical hash to `verified+complete`; config/tombstone row and section event share one deferred operation binding; finalize-vs-prune prescribed order has no wait cycle and endpoint-before-fence mutation produces `40P01`; bigint seq > 2^53; NULL/cross-workspace/base/sheet refuse; floor-aware replay; production backend (when claimed) survives hot-DB/host loss | `RESET_RETENTION_CONFLICT` while retention ON and Phase D not owner-accepted; current unbounded `seq <= anchor` not used as D4 |
| **Mutation** | Truncated ciphertext / auth-tag fail / **wrong-key** / same KMS-attested `dek_fingerprint` plus repeated nonce on two section objects / moving nonce reservation after AEAD or upload / moving MAC/sign/verify/unwrap into a DB transaction / **tampered manifest** (payload+unkeyed-hashes rewritten together) / missing, duplicate, unknown or reordered section or `entity_key` / forged row count / wrong source vector / wrong-generation / cross-sheet / cross-workspace / expired or held archive => refuse before live write; inserting a forged coverage row after verification or omitting/changing an exact coverage id/source hash, including one record revision, marker, **v2 section revision**, associated config/field-tombstone/link-tombstone row, snapshot/aggregate membership, or endpoint child of whole-operation prune, => prune refused; remove the ordinary-sweep `operation_id IS NULL` predicate => an operation tears and the golden reds; conflate source pins with archive-object references, drop direct-delete source-pin check, or drop immutable-version check => incomplete/unsafe and red; concurrent stale cleanup cannot unpin another owner/fence; expire/delete/burn-prune/key-destroy under legal hold, sole complete coverage, running job, or surviving key reference refused; supersession-only deletion or external delete without the expired intent/receipt must red; leaving the baseline age-only burn DELETE callable must delete a provenance-NULL burn and red; omit any link/config/attachment/auto-number section event => direct endpoint seal fails; bind a genesis event to the zero-direct-event snapshot parent, omit its distinct operation id, bypass either dedicated zero-direct-event seal, omit/reorder a membership, duplicate a child, or use the last chunk as terminal => synthetic seal fails; allow new key reference after `retiring` or conflate block/worker fences => red; neuter overlay still diverges hashes | Flag-off byte-identical retention/recovery routes vs this baseline |
| **Bootstrap / coverage** | First archive of a populated sheet with no Phase-D section history reserves one operation id + seq per missing genesis head and a distinct parent id + greater seq; finalize atomically seals every one-event `section_bootstrap`, inserts deferred-FK memberships, and inserts the zero-event `archive_snapshot` parent LAST; retry is idempotent; concurrent writer either precedes the captured vector or is blocked; coverage rows exist only while parent is `building` and their exact projection equals the MAC-bound `coverage_index` | Partial genesis, parent-bound genesis events, missing/nondeferred operation FKs, record-only relabel, post-verify coverage INSERT/UPDATE/DELETE, range-only coverage, or individual age-prune of an operation-tagged row |
| **Burn lifecycle** | Sync accept/live writes/sealed operation/audit/burn commit together with `job_id IS NULL` and terminal time; async accept burns once with non-NULL job and terminal time appears only at terminal transition; separate prune goldens prove both shapes retain through their exact replay horizon; provenance-NULL rows stay | Generic `job_id IS NULL` prune, guessed legacy kind/timestamp, sync burn without sealed operation, async burn without job, or either burn disappearing before its operation/job/audit proof |
| **Crypto uniqueness** | Two objects under the same KMS-attested DEK identity and nonce make the durable pre-encryption reservation refuse, with the encryption/upload spy still at zero calls; the same nonce under two provably different DEK identities remains valid; wrapped-DEK re-randomization cannot change the DEK identity | Wrapped-ciphertext hash as identity; reserving at finalize; relying on random nonce generation without a uniqueness reservation or mutation proof |
| **Fault** | Kill archive builder in claim/capture/crypto-reservation/upload/finalize => hot rows intact, no prune, exact build attempt becomes `abandoned`, and source pins/key refs release only after staged-object absence under newer owner/fence while nonce tombstones remain; transaction-depth instrumentation proves **every** DB transaction across build/finalize/verify/restore performs zero provider/object-store/KMS calls; slow KMS/object store holds no database transaction or advisory fence and obeys staging byte/time cap; a claim racing key retirement either commits its reference before `retiring` or writes zero after it, never after `ready`; race legal-hold placement with object deletion `ready -> deleting` => exactly one side wins and provider delete is unreachable when hold wins; crash before call, after provider acceptance, and after provider success but before DB receipt for both object deletion and KMS destruction => lease expiry plus exact worker-fence CAS transfers ownership, reuses one immutable provider idempotency key, reconciles status outside DB transactions, converges to one receipt, retains references/key `retiring` while ambiguous, and never records `deleted`/`destroyed` without provider confirmation; kill async worker before/after chunk commit => receipt and writes agree and resume never double-applies; worker-lease takeover preserves the immutable job block fence; writer attempts between chunks blocked; revoke/drift after one chunk => `abandoned_partial`, no later write, block CAS-released; only done aggregate endpoint advertised; burn rolls back with failed acceptance and remains while job nonterminal | Token replay `token-replayed`; archive/job/provider fence-CAS zombies write 0; no unsealed operation spans committed transactions |
| **Scale** | Sheet above 5000 records: sync refuse or async path, never silent truncate; bounded DELETE/upload batches; progress persisted | Existing `SHEET_REVERT_DEFAULT_MAX_RECORDS = 5000` until post-W0 measurement changes it |
| **Storage domain** | Test/staging may use local FS. Production acceptance proves independent durability and failure-domain separation from hot DB/host | Same-host local files not silently reclassified as production archive |
| **Attachments** | Source pin-intent durable before blob read; all source deleters including direct route/provider honor it; immutable version/hash copied to sealed staging; finalize creates a distinct archive-object reference before releasing the source pin; source purge cannot delete archive copy; archive deletion requires expired D-L intent/receipt; missing/drift keeps coverage incomplete; concurrent builder vs delete; stale cleanup owner/fence-safe | Generic pin class, releasing archive ownership with the source pin, ENOENT, or mutable source never a verified success |
| **Links / config / tombstones** | After matching hot evidence is pruned, sections reconstruct from archive; every Phase-D live mutation emits a same-txn seq/operation-bound section revision and contributes to endpoint count/max; config/tombstone evidence rows carry the same deferred operation id, remain excluded from row sweeps, and leave only with their covered whole operation; resurrect still `INBOUND_UNPROVABLE` | Record-only endpoint never advertised as full-sheet Phase-D anchor; terminal tombstones never used as at-anchor inbound proof |
| **Permissions** | Actor without full-table read: no token, no job; revoke between preview and execute: zero writes | Live grants unchanged after data restore |
| **Values-free** | Ordinary log fixtures contain only state/code/count/format/section and optional opaque digest -- no workspace_id/base_id/sheet_id/actor_id | Catalog may store identity under access control; burn table stores sha256 not the token |

§12.6 bullets map onto this table 1:1; D7 is the evidence bundle, not a second contract.

## 8. Rollback and non-goals

### 8.1 Rollback (after a future default-off land, still not enablement)

- Flag unset / not exact ON -> archive writer, prune handoff, restore routes are no-ops or refuse
  closed; hot retention and L8 behave as this baseline.
- Catalog rows may remain (inert). Do not DROP verified objects as a "rollback" of a flag.
- Migration `down()` is development-only. It must first prove the Phase-D catalog, jobs, chunks,
  holds, and pins are empty; otherwise it refuses without changing either database state or external
  objects. It never deletes object-store bytes, removes pins, or destroys KMS keys.
- No reverse migration of hot history that was never pruned.
- Do not roll back Phase B or O-2 L1 as part of Phase D abort.

### 8.2 Non-goals (repeat, operational)

- Runtime, flags, deployment, production, E1 ratify, L2+ ladder steps.
- Recovering bytes never archived and never captured.
- Permission restore; cross-sheet transaction; wall-clock destructive restore.
- Lifting resurrect on the strength of #4446 or of archived terminal tombstones.
- Reclassifying operator backups as Time Machine archives.
- Marketing completeness / "platform-generic archive service" beyond this customer's exact-anchor
  sheet restore.

## 9. Remaining owner decisions (this lock cannot self-ratify)

1. **Ratify this file** (exact SHA) or return REQUEST_CHANGES. Until then D2 must not merge.
2. **Recovery-horizon defaults** (days / count / never-expire) -- policy values, not D1.
3. **KMS / key custody** for D-F (product choice; AEAD+manifest MAC interface is locked).
4. **Whether system sheets** may ever enter the catalog (D-C currently excludes).
5. **Whether D5 names any conflict policy other than refuse** (D-J default = refuse).
6. **Staging object backend** may be local. **Production** backend is an independent owner choice
   that must prove durability and failure-domain separation (D-E); adapter stays vendor-neutral.
7. **E1 / L2+ / retention ON** remain independent. Phase D evidence does not substitute.
8. **Scheduling / landing of the §1.4 reconstruction-floor correction** (exclusive
   `trusted_since_seq` window + floor-aware strict precheck + goldens). D2+ depends on it; this
   file does not implement it.
9. **Writer-fence prerequisite:** D2 archive capture may run only where the canonical writer fence
   and its complete writer/deleter census are exact-ON and current. This is a runtime prerequisite,
   not permission to enable that flag; owner/ops must separately authorize any rung that turns it on.
10. **Complete section causality:** owner ratification accepts that a full-sheet Phase-D endpoint is
    valid only after record, marker, link, config, attachment-index, and auto-number events share the
    operation/sequence ledger in §D-I0. A record-only endpoint remains ineligible.

---

*End of D1. Status remains PROPOSED. No runtime follows from this file.*
