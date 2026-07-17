# W0-1 (v3.7) - exact event anchor + causal seq + all-writer fence + trust checkpoint - DESIGN LOCK

- **Status (2026-07-16): RATIFIED — owner directive 2026-07-16, mechanically recorded (not self-approval).** The
  owner's review resolved finding #1 (batch/operation decoupling, §1.2/§1.3/§10) and explicitly authorized: merge the
  finding-#1 revision into #4331, flip this lock to RATIFIED, and merge #4331 into main — with **zero runtime in the
  same step**. Ratification authorizes default-off implementation slices only (§9 tail unchanged): no strict-mode
  enablement, no Revert/Reset enablement, no host mutation, no staging cutover, no production rollout, all flags OFF.
- **Finding #1 resolved (owner review 2026-07-16).** The owner's adversarial review found this lock's §1.2
  `batch_id == operation_id` aliasing breaks the ratified S1 batch-grouping lock (one commit action = one batch
  spanning N transactions). §1.2 and §1.3 are corrected below to make `batch_id` (S1 user-action grouping) and
  `operation_id` (per-transaction sealed endpoint) **distinct**, the recovery anchor keys on the operation endpoint
  (v1 = the selected batch's terminal operation, §10 ruling 5), and §10 records the owner's eight ratified terms +
  the mandated G-MULTIOP-BATCH golden (§6).
- **Canonical scope:** this is the single fix-forward design for the W0 trust substrate. It supersedes the proposed
  v3.6 document merged in #4328 and the still-open #4262 mechanism text. The useful L3 work in Draft #4309 is an
  implementation input, not an authority and not merge-ready until this lock is ratified and its L3 corrections land.
- **Grounding:** `origin/main` at `ffad80b97` (contains #4269, #4320, #4325, #4328). Source sites were re-read on that
  tree; line numbers below are orientation anchors and must be refreshed before implementation.
- **Containment:** after #4329 merged, read-only run
  [29427111850](https://github.com/zensgit/metasheet2/actions/runs/29427111850) returned PASS for both production and
  staging: `MULTITABLE_ENABLE_SHEET_REVERT` and `MULTITABLE_ENABLE_PIT_RESET` were absent from each backend's running
  environment and from its rendered next-restart Compose configuration. The workflow rebuilt Compose from each
  running container's `config_files` + `working_dir` labels. No recovery flag was changed by this verification.

## 0. Why v3.6 is not ratifiable

### P1-A - in-transaction `effective_at` is not an exact commit boundary

v3.6 proposed taking `clock_timestamp()` after the sheet fence and before the mutation commits, then resolving
`B(T) = MAX(seq) WHERE effective_at <= T`. The fence orders writers, but it cannot move the timestamp to COMMIT.

Constructed counterexample:

1. Writer W acquires the canonical fence at `t=100`.
2. W stores `effective_at=101`, mutates the record, and remains in the transaction.
3. An as-of instant `T=105` passes.
4. W commits at `t=110`.

A later query for `T=105` includes W because `101 <= 105`, although W was not committed and not visible at 105.
The state is a future/uncommitted state for that T. This is independent of NTP rollback; the ordinary pre-COMMIT
interval is enough. Taking the timestamp as the last application statement only narrows the interval and does not
close it. PostgreSQL does not expose the current transaction's durable commit timestamp from inside that transaction.

**Ruling proposed by v3.7:** destructive Revert/Reset use exact committed event ordinals only. A free wall-clock T may
remain a read-only approximate navigation surface, but it is not an executable recovery authority. Exact wall-clock
execution would require a separate commit-time materialization design (for example durable post-commit commit-time
capture), not an in-transaction timestamp relabeled as exact.

### P1-B - execute currently recomputes before the fence, not under it

`computeSheetReset` / `computeSheetRevert` and preview-identity verification run before the destructive transaction.
Reset's transaction then takes `PIT_RECOVERY_LOCK_NS`, reruns only the history-integrity precheck, and writes the
previously computed set (`univer-meta.ts:10431+`). Even after every writer adopts the canonical fence, this race
remains:

1. Execute computes and verifies set S outside the fence.
2. A healthy fenced writer creates or edits a record and commits.
3. Execute acquires the fence. The integrity precheck passes because the new write has a valid revision.
4. Execute applies stale S. A post-anchor create can escape Reset's delete set; a schema change can leave a stale diff.

The fence prevents writes *after acquisition*; it cannot make an earlier read atomic retroactively. C8 must therefore
mean **full in-fence recomputation with the same frozen anchor**, not merely "rerun the chain precheck".

### P2-A - the all-writer matrix is incomplete

v3.6 omitted `dropFieldCascade` (`univer-meta.ts:6115+`), reached by both forward field-delete and config un-create.
It writes config history/tombstones and strips a field key from every `meta_records.data` row. It must serialize with
checkpoint capture and destructive recovery. The auto-number field-create/type-conversion paths also acquire the
current helper only inside `backfillAutoNumberField`, after config work has begun; L4's fixed lock ordering requires
the canonical fence at the transaction boundary, not a late helper call.

### P2-B - `MAX(seq) WHERE batch_id=...` is not enough by itself

The resolver must scope by sheet, accept only server-minted committed operations, freeze the exact endpoint in the
signed preview identity, and never re-resolve a mutable `MAX(seq)` during execute. Otherwise later accidental batch-id
reuse, partial retention, or a cross-sheet collision can move the target after preview.

One more invariant is load-bearing: an exposed anchor must be a **transaction endpoint**. A seq in the middle of a
multi-row transaction represents a state that was never externally visible. A caller convention saying that one batch
id maps to one transaction is not proof; the current `batch_id` column does not prevent a later transaction from
appending another row with the same value. Section 1.2 therefore adds a sealed operation-endpoint ledger. The anchor is
the endpoint row of one committed operation, not an ad-hoc `MAX(seq)` over mutable event rows.

### P2-C - production-magnitude bigint tests must not poison the shared sequence

The v3.6 `setval('meta_record_chain_seq', ...)` goldens would permanently advance a non-transactional global sequence
inside the shared real-DB test bundle. Near-`int8` tests can break unrelated later tests or exhaust the sequence.
Goldens must insert explicit synthetic seq values into isolated fixture rows (or a disposable per-test sequence/table)
and clean only their own objects. They must never `setval` the production sequence.

## 1. Locked state model

### 1.1 One causal order, exact end to end

- `meta_record_revisions` and `meta_record_version_markers` share one `BIGINT seq` domain.
- Seq is allocated in the same transaction/connection **after** taking the canonical sheet fence.
- The PG sequence alone is not causal. Causality begins only after L4 is on every writer and an L5 checkpoint cuts off
  pre-fence/backfilled history.
- SQL compares bigint natively. Node keeps seq as decimal string or `bigint`; JSON uses decimal strings. `Number`,
  `parseInt`, unary `+`, subtraction comparators, and JSON number fields are forbidden for seq/boundaries.
- Legacy backfill is display/order assistance only. It is never a trust signal.

### 1.2 Sealed operation endpoints

Add a post-cutover operation ledger (name illustrative, schema contract normative):

`meta_record_history_operations(sheet_id, operation_id, endpoint_seq, event_count, created_at)` with primary key
`(sheet_id, operation_id)`. Add nullable `operation_id` to revisions and version markers; new trusted writers set it,
while legacy/backfilled rows remain outside the trust checkpoint. A revision continues to expose `batch_id` for the
existing History UI **as an INDEPENDENT column**: `batch_id` and `operation_id` are **distinct and MUST NOT be aliased**
(finding #1 correction, owner review 2026-07-16). Per the ratified S1 batch-grouping lock
(`…batch-grouping-s1-designlock`, LOCK-B B2: *"one COMMIT ACTION = one batch"* — a commit action MAY span the several
per-row `patchRecords` transactions that share one server-minted `batchId`), `batch_id` remains the **user-action
grouping** key: one commit action → one `batch_id` → **N** `operation_id`s (one sealed transaction endpoint per
transaction). A trusted revision therefore carries **both** — its S1 `batch_id` (grouping, unchanged) and its
per-transaction `operation_id` (the sealed transaction endpoint). Setting `batch_id := operation_id` is **forbidden**: it
would re-split one History batch into N single-row batches at the projection grouping key (`row.batch_id ?? row.id`) and
break the batch deep-link, reverting the ratified S1 goldens G2/G5. Marker rows gain the operation identity **in their
own `operation_id` column**, never by overwriting `batch_id`.

The write protocol is one transaction and one connection:

1. Mint one request-unforgeable operation id per sheet transaction.
2. While holding the canonical fence, write every revision/marker with that operation id and an exact seq.
3. Insert the endpoint row **last**, with `endpoint_seq = MAX(event seq in this operation)` and the exact event count.
4. Commit. An aborted transaction exposes neither events nor endpoint.

Database enforcement is required, not just service comments:

- event-to-endpoint foreign keys are `DEFERRABLE INITIALLY DEFERRED`, so events may precede the endpoint in the same
  transaction but no committed trusted event can lack its endpoint;
- event insertion refuses an operation whose endpoint row is already visible, preventing a later transaction from
  appending to a sealed operation;
- endpoint insertion validates the same-sheet event count and max seq across both event tables; mismatch raises and
  rolls back the writer;
- one transaction spanning several sheets uses one separately sealed per-sheet operation identity. A future base-wide
  coordinator may carry a parent id, but it cannot weaken the per-sheet endpoint.

The endpoint row is visible only after its writer commits, so it is the exact externally visible boundary that an
in-transaction wall-clock sample cannot provide. Operations with no record revision/marker are not executable record
anchors; schema writers still take the L4 fence so checkpoint and execute see a coherent schema.

### 1.3 Exact recovery anchor

The executable API takes an opaque/server-resolved history anchor, not an authoritative client seq:

1. UI selects a committed recovery point. The shipped A2 picker selects a History **batch**; because one S1 `batch_id`
   spans **N** sealed operations (§1.2 finding #1 correction), the picker/server MUST resolve that selection to a single
   **operation endpoint** — the recovery anchor is *"the sheet state after operation E committed"*. **v1 is FIXED
   (owner ruling 2026-07-16): the resolved endpoint is the terminal operation of the selected batch — the sealed
   endpoint with the greatest `endpoint_seq` among the SAME-sheet, SAME-batch sealed endpoints.** An operation-level
   mid-batch selector is explicitly **OUT of v1** — if wanted later it is a separate follow-up slice with its own lock,
   not an implementation choice left to L6-b. The anchor identity is an `operation_id`, not a `batch_id`.
   **Interleaving honesty (owner ruling)**: other writers' legitimate writes that commit BETWEEN the batch's member
   transactions are part of the real sheet state at that terminal endpoint and MUST NOT be filtered out to fabricate a
   fictional "batch-atomic state" — the anchor means the true committed sheet state at that endpoint, nothing else.
   **Legacy/unsealed batches (owner ruling)**: a selected batch with no sealed same-sheet endpoint (legacy rows,
   pre-cutover writes, unsealed operations) returns the uniform `EXACT_ANCHOR_REQUIRED`-class refusal — it NEVER falls
   back to wall-clock resolution.
2. Preview sends `anchorOperationId` (an opaque operation-endpoint handle, **not** a bare `batch_id` — the two are no
   longer equal); server validates actor + sheet scope, resolves it to the sealed same-sheet operation whose
   `operation_id` matches, and returns one values-free refusal for missing, pruned, cross-sheet, or inaccessible
   evidence.
3. Server takes `anchorSeq` from that immutable endpoint row. It verifies the endpoint's count/max against retained
   event rows; it never derives authority from a fresh `MAX(seq) WHERE batch_id=...` scan (a batch spanning N operations
   would make such a scan meaningless as an anchor).
4. Server selects the latest retained checkpoint with `trusted_since_seq <= anchorSeq`, ordered by
   `(trusted_since_seq DESC, id DESC)`.
5. Preview identity binds at least `{sheetId, anchorOperationId, anchorSeq, checkpointId, actorId, scope hashes}`.
6. Execute verifies the signed claims, uses the token-bound `anchorSeq`, and reruns the full target computation under
   the fence. It does not recompute `MAX(seq)` as its authority. Missing/pruned/mismatched anchor evidence is 409 and
   zero writes.

Raw `anchorSeq` from request input is never trusted. The server may return an opaque anchor id to the client; exposing
the decimal seq is unnecessary. The selected anchor means the sheet state **after the entire selected operation
committed**; an intermediate row in that operation is never selectable.

### 1.4 Wall-clock surface

- History labels may continue to display `created_at`.
- History list ordering for trusted/post-checkpoint rows must follow seq/operation endpoint, not `created_at`.
- Advanced manual datetime and point-in-time read may remain as explicitly **approximate** navigation. They may resolve
  to nearby committed batches for display, but cannot mint a destructive preview identity.
- Revert/Reset preview from a free wall-clock value returns an exact-anchor-required refusal until the user selects a
  committed history event.
- If exact arbitrary wall-clock execution remains a product requirement later, open a separate commit-time design.
  It must materialize durable commit visibility and cover the commit interval; `clock_timestamp()` inside the writer
  transaction is explicitly rejected.

## 2. L4 canonical sheet-state fence

### 2.1 Lock contract

- Keep the existing `meta:auto-number:sheet:${sheetId}` advisory key during rolling deploy; rename/move the helper, not
  the key. A new key would let old and new instances pass each other.
- Every in-scope entry is: `BEGIN -> canonical fence -> reads/checks -> mutation + seq/revision/marker -> COMMIT`, one
  connection, all-or-nothing. A bare autocommit lock is invalid.
- Reset/Revert lock order is canonical fence first, then `PIT_RECOVERY_LOCK_NS` if that second recovery-only lock is
  retained.
- Any future operation touching multiple sheet states acquires all canonical fences in sorted sheet-id order.
- Recovery execute performs anchor/checkpoint resolution, target-generation precheck, schema/load, exact-set
  recomputation, preview-identity verification, and writes inside this fenced transaction with the same anchorSeq.

### 2.2 Writer matrix

Implementation must rescan current main and deliver an entry-to-transaction-to-fence-to-mutation table. Minimum
families are:

| Family | Current production anchor | L4 posture |
|---|---|---|
| REST create | `record-service.ts:500+` | keep fence; prove it is first txn statement |
| REST patch/delete/trash restore | `record-service.ts:1334+`, `:deleteRecord`, `:restore` | add outer fence |
| bulk/AI/OAPI patch | `record-write-service.ts:pool.transaction` | add outer fence once in service core |
| plugin create/patch/delete | `multitable/records.ts` | create keeps; patch/delete add |
| automation create/update/delete | `automation-executor.ts` | add inside real `deps.transaction`; no fallback for strict writer |
| HTTP + automation lock/unlock markers | `univer-meta.ts:16504+`, `automation-executor.ts:3497+` | add; marker + bump same txn |
| form create/edit | `univer-meta.ts:14525+` | keep and prove first txn statement |
| attachment delete cell-strip | `univer-meta.ts:15888+` | add |
| approval result writeback | `automation-service.ts:2866+` | add |
| field delete + config un-create | `dropFieldCascade`, forward route `:11688+`, restore route `:8904+` | **newly added**; fence before capture/drop/column strip |
| field create/update with auto-number backfill | `univer-meta.ts:11048+`, `:11378+` | move fence to txn boundary; late helper lock is insufficient |
| field undelete rehydration | `recreateFieldFromConfig` | add at config-restore txn boundary |
| lossy retype rewrite | `applyLossyRetypeCellRewrite` | add at config-restore txn boundary |
| PIT resurrect/revert/reset | `univer-meta.ts:10210+`, `:10431+` | canonical -> PIT; full in-fence recompute |

Explicit exemptions must be named and pinned, not silently absent:

- approval projection and People directory are server-owned `system_kind` sheets;
- seeded demo rows exist only at new-sheet birth before any active checkpoint;
- formula/lookup/rollup/auto-number materializations are non-restorable derived fields already excluded by
  `DERIVED_FIELD_TYPES` and `NON_RESTORABLE_TYPES`. Goldens must prove they cannot change the restorable projection.

If an alleged derived writer bumps record version, touches a restorable field, or becomes user-authored, it leaves the
exemption and must join the fence + revision contract.

## 3. L5 trust checkpoint and system identity

- Checkpoint and baselines stay in separate tables; no synthetic history action.
- Cutover is one fenced transaction. Allocate `trusted_since_seq` under the canonical fence, then snapshot all live and
  recoverable-trash baseline rows, supersede prior active, activate new, commit.
- Strict recovery remains code-default-off. With strict mode on, a sheet with no active checkpoint, an anchor below the
  retained trust floor, or a checkpoint still in `building` fails closed with one values-free `HISTORY_INCOMPLETE`;
  migration/backfill presence alone never enables recovery.
- Destructive selection is seq-based: latest retained checkpoint with `trusted_since_seq <= anchorSeq`. A checkpoint's
  wall-clock field is display/ops metadata, not the recovery authority.
- Reconstruction is `baseline + events where trusted_since_seq < seq <= anchorSeq`. Pre-checkpoint/backfilled rows never
  carry trust.
- Retention preserves the checkpoint selected by the oldest legal retained anchor, all newer checkpoints, complete
  operation/batch endpoints, and any referenced tombstone payload. It may over-retain on ambiguous time; it may not
  create a partial operation anchor.
- `meta_sheets.system_kind` is server-owned and set only by internal provisioning. User create/update cannot set it.
  `isSystemSheet` uses `system_kind`, not a user-writable description sentinel.

## 4. Target-generation integrity

Given frozen boundary B for each record:

- determine the generation containing the latest chain event `seq <= B`;
- if target is absent at B (latest event is terminal delete), no record payload is reconstructed;
- otherwise validate exactly one occupant for every expected version from the checkpoint baseline/generation create
  through B, with delete's terminal version-reuse handled explicitly;
- validate revisions and markers in one exact seq timeline; invalid/non-positive/duplicate seq is `comparator_error` /
  `chain_corrupt`, never coercion to zero;
- enumerate live rows plus records that existed at B but are now deleted, using baseline + revisions + trash;
- terminal-generation-only validation is forbidden.

Target-generation A is the terminal design. Conservative all-post-checkpoint-generation validation may be a temporary
fail-closed implementation rung, but cannot be called complete because it rejects healthy target windows.

## 5. Execute atomicity and preview binding

Preview is read-only and may run without holding a long transaction. Execute is authoritative:

1. authenticate and parse opaque anchor request;
2. `BEGIN`;
3. acquire canonical sheet fence, then recovery lock if retained;
4. resolve/validate the signed token-bound checkpoint + anchorSeq evidence;
5. recompute schema, target states, target generations, exact revert/resurrect/delete sets and hashes at B;
6. verify preview identity against this in-fence recomputation;
7. lock affected rows, recheck record locks/permissions/versions;
8. apply all writes + revisions/tombstones, then COMMIT.

Any mismatch is 409/403 as appropriate and zero writes. Revert needs one outer transaction; its current per-record
transaction loop remains gated until that refactor lands.

## 6. Required goldens

All real-DB tests must be explicitly listed in `plugin-tests.yml` and mutation-proven to run.

- **G-COMMIT-WINDOW:** mutation to pre-COMMIT `effective_at` mapping selects the future write for T in
  `(effective_at, commit)` and reds; exact event anchor returns the correct prefix.
- **G-PHANTOM-BEFORE-FENCE:** writer commits after outer compute but before execute takes fence. In-fence recompute makes
  identity drift and 409s; removing full recompute reds.
- **G-SCHEMA-BEFORE-FENCE:** field delete/retype commits in the same gap; stale diff cannot execute.
- **G-TARGET-OLD-GEN:** clean terminal generation + hole in selected old generation refuses; terminal-only mutation reds.
- **G-DELETED-TARGET:** currently deleted, existed at B, old-generation hole refuses; healthy positive control passes.
- **G-BATCH-ENDPOINT:** multi-row same-transaction batch anchors after all rows, never at an intermediate seq; cross-sheet
  or later batch-id reuse cannot move signed B. Mutations that omit endpoint insertion, append after sealing, publish a
  wrong event count/max, or move endpoint insertion to another transaction each red and roll back the writer.
- **G-MULTIOP-BATCH (owner-mandated, 2026-07-16 — pins the original finding-#1 defect):** one AI commit spanning **N**
  per-row `patchRecords` transactions (the S1 LOCK-B shape) must show, on a real DB: (a) ALL N revisions keep the SAME
  S1 `batch_id` — the ledger's `operation_id` never overwrites it; (b) N DISTINCT `operation_id`s and N sealed
  endpoints are minted (one per transaction); (c) the History projection still aggregates the commit as **ONE** batch
  and the batch deep-link (`GET /bases/:baseId/history/events/:batchId`) resolves unchanged; (d) the anchor resolver
  selects the greatest `endpoint_seq` **only among the same-sheet, same-batch sealed endpoints** (v1 terminal
  operation); (e) a legacy/unsealed batch gets the uniform `EXACT_ANCHOR_REQUIRED`-class refusal with NO wall-clock
  fallback. Mutations: restoring the `batch_id := operation_id` overwrite reds (a)+(c); resolving across a different
  batch's or sheet's endpoints reds (d); any wall-clock fallback path reds (e).
- **G-BIG-1/2:** explicit fixture seq values at 2^53 neighbors and near int8 max remain distinct through SQL/TS/API
  strings. No global production-sequence `setval`.
- **G-FENCE-FAMILY:** remove/wrong-client/late-acquire fence per writer family -> its constructed race reds.
- **G-FIELD-DROP:** checkpoint and field-delete/config-uncreate serialize; no torn baseline/tombstone/config state.
- **G-SYSTEM-KIND:** user-spoofed legacy description is still checked; true server system sheet is excluded.
- **G-FLAG-OFF:** all new runtime remains unreachable with flags off; schema presence is not described as byte-identical.

## 7. Implementation order and estimate

| Order | Slice | Exit condition | Estimate |
|---|---|---|---|
| 0 | containment/tooling | #4329 merged; read-only target=both run 29427111850 PASS; no env flip | complete |
| 1 | L3 correction | salvage #4309 + exact bigint + target-generation shape + existing P2 fixes | 1-1.5 pw |
| 2 | L4 fence + C8 | complete writer/exemption matrix; full in-fence execute recompute | 3-4 pw |
| 3 | L5 checkpoint/system_kind | active baseline, seq trust floor, retention + spoof goldens | 2-3 pw |
| 4 | L6 exact event anchor | sealed operation ledger, endpoint resolver, signed frozen B, seq reconstruction/history ordering, FE/API wiring | 2-3 pw |
| 5 | L7 target generation | exact A implementation + deleted/trash enumeration | 1-1.5 pw |
| 6 | L8 Revert outer transaction | one fenced all-or-nothing Revert execute; Reset parity | 1-2 pw |
| 7 | re-measure + rollout | #4273 on corrected main, staging cutover rehearsal, then separate flag decision | 0.5-1 pw |

W0 trust correction from current main is approximately **10.5-16 development person-weeks**. The broader product
remainder (async >5k/base-wide recovery, T-state UX, and O-2 rollout) remains downstream and is not hidden inside this
estimate.

## 8. Current-source verification

Read-only review on the grounded main SHA confirmed the design is correcting live code, not a hypothetical surface:

- `ResetToPointPicker.vue` selects a History `batchId` but converts it back to `createdAt`; `resetPreview` and
  `resetExecute` receive only `asOf`.
- `PitRevertPreviewIdentityClaims` and `PitResetPreviewIdentityClaims` bind `asOf` plus scope hashes, but no committed
  operation endpoint or checkpoint id.
- reset execute calls `computeSheetReset` and verifies the identity before entering `pool.transaction`; inside the
  transaction it takes only `PIT_RECOVERY_LOCK_NS` and reruns only the integrity precheck. Revert likewise computes
  outside an outer all-record transaction and applies field reverts through per-record service transactions.
- `dropFieldCascade` removes the field key from every `meta_records.data` row and writes config/tombstone history, so it
  is a real checkpoint/schema writer even though it intentionally emits no per-record revision.
- the present system-sheet predicate still trusts approval base identity plus a user-writable People-sheet description;
  `system_kind` is therefore a required hardening, not a documentation cleanup.
- the existing preview/read surfaces still reconstruct with wall-clock `created_at`; #4309 is Draft and does not make
  those paths exact.

Validation performed for this design revision: source-site search, direct route/helper inspection, exact #4328 diff
review, `git diff --check`, and a full-text contradiction sweep for the rejected `effective_at`, mutable `MAX(seq)`,
terminal-generation, and production-sequence-`setval` designs. No runtime test is claimed by this docs-only lock; the
required executable evidence is the mutation-proven matrix in section 6.

## 9. Owner decisions requested (RULED 2026-07-16 — ratified with the batch/operation terms in §10)

Recommended ratification bundle:

1. **Executable anchor:** committed history batch/event only; no free-wall-clock destructive execution.
2. **Manual datetime:** read-only approximate navigation until a separate exact commit-time design exists.
3. **Generation:** target-generation A as terminal state.
4. **Fence:** preserve the existing auto-number key; rename to canonical sheet-state fence; canonical -> PIT lock order.
5. **Execute:** full target/schema/set recomputation and preview verification under the fence.
6. **Batch endpoint:** sealed operation ledger; server-minted, sheet-scoped, one transaction group; exact anchorSeq
   frozen in signed identity.
7. **Bigint:** string/bigint end to end; no production-sequence mutation in tests.

Ratification authorizes default-off implementation slices only. It does not authorize strict-mode enablement,
Revert/Reset enablement, host mutation, staging cutover, or production rollout.

## 10. Owner ruling record (2026-07-16) — batch/operation decoupling ratified terms

The owner's 2026-07-16 review approved the following design decisions verbatim (mechanically recorded here; this
section is the authority the finding-#1 runtime decouple and L6-b implement against):

1. `batch_id` and `operation_id` are **permanently decoupled**.
2. `batch_id` keeps the user commit-action grouping (S1); it must **never be overwritten** by an operation id.
3. One batch may map to **multiple** transaction operations.
4. Recovery identity is **`anchorOperationId`**.
5. **v1 fixed choice:** the anchor resolves to the selected batch's terminal operation — greatest `endpoint_seq`
   among the SAME-sheet sealed endpoints of that batch.
6. An operation-level mid-batch selector is explicitly **OUT** — a separate follow-up slice, not an L6-b freedom.
7. Other writers' legitimate writes interleaved between the batch's member transactions belong to the endpoint's
   REAL sheet state; they must not be filtered into a fictional "batch-atomic state".
8. A legacy/unsealed batch returns the uniform `EXACT_ANCHOR_REQUIRED`-class refusal; **no wall-clock fallback**.

The same ruling mandates the **G-MULTIOP-BATCH** golden (§6) pinning the original defect (one AI commit across N
`patchRecords` transactions), and authorizes: merging this revision into #4331, flipping #4331 to RATIFIED, and
merging #4331 into main — **without** any runtime merge in the same step. Runtime integration then proceeds
L3 → L5 → L4 → L4cov → L6-a (+ endpoint-immutability + runtime decouple), each layer on then-current main with full
required CI and an exact-head independent gate; all flags stay OFF. **(This §10 integration order is SUPERSEDED by
the §11 amendment below.)**

## 11. Owner amendment — integration order + take-over discipline (2026-07-16)

The runtime integration split the ratified slices finer than §7/§10 named, and the actual landing on `main` diverged
from §10. This amendment is the **OPERATIVE order and SUPERSEDES the order clauses of §7 and §10.** (Design semantics
in §1–§6 are unchanged.)

**Why the divergence (no rollback):** L4 (all-writer canonical fence, #4346) merged to `main` (default-OFF) before the
reorder was finalized. It is NOT rolled back — the lane's runtime wiring IS present in production code paths on `main`,
but every fence/mint call is gated behind flags that stay default-OFF (inert no-op while OFF; this is *gated exposure*,
not zero exposure), and L5 was re-gated on a combined ancestry that already includes L4 + L4cov, so safety is no lower
than §10's L5-first order. (With the L6-a H3 hardening, flag-ON against an incomplete schema fails closed — the writer
transaction rolls back rather than degrading to an inert ledger.)

**Slice split (finer than §7's "L5"/"L6"):**
- §7 row 3 "L5" → **L5** (trust-checkpoint SCHEMA + state machine — Phase A) + **L5-wire** (checkpoint ACTIVATION runtime — Phase B).
- §7 row 4 "L6" → **L6-a** (sealed operation-endpoint ledger + row immutability — Phase A) + **L6-b** (exact-anchor RESOLVER + signed preview identity — Phase B).
- New **L4cov** rung: a writer-coverage extension of L4 (fences the writer families L4 left partial), landed as its own INDEPENDENT rung.

**Phase A — trusted-substrate DAG to `main` — SUPERSEDES §10's `L3→L5→L4→L4cov→L6-a`:**
> **L3 → L4 → L4cov → L5 → L6-a**

Each layer rebased on then-current `main`, with **full required CI + an exact-head independent gate before merge**;
flags OFF. **L6-a is merged as a COMBINED rung** — one PR carrying the sealed-endpoint ledger together with its two
riders, endpoint-immutability + batch/operation runtime decouple — gated once on the combined head with a fresh
G-MULTIOP-BATCH mutation run. *(As landed: the combined rung is **#4409** `2f456571e`, which carries all of the above
plus the H1/H2/H3 owner hardenings; the draft stack #4368/#4380/#4385 and the alternative combined branch #4412 were
closed as superseded by it — see the companion status doc.)*

**Phase B — recovery-consuming layers — clarifies §7's `L6→L7→L8`; starts ONLY after the Phase A DAG is fully on `main`:**
> integration + exact-head gate order = **L5-wire → L6-b → L7 → L8**, where **L8 is based on BOTH L6-b AND L7**
> (its fenced all-or-nothing Revert execute uses L6-b's token-bound anchor **and** L7's target-generation validation).

Drafting the four Phase-B slices MAY proceed in parallel, but each **MERGE is serial** in the order above, each on
then-current `main` with full CI + an exact-head independent gate. All recovery flags stay default-OFF.

**Phase C — enablement (unchanged, owner/ops-only):** strict-mode / Revert / Reset enablement, staging cutover, #4273
re-measure, and any production flag flip remain OUT of autonomous scope. This amendment authorizes default-OFF
implementation slices only (as the §9 tail).

**Take-over discipline (recorded so all integration sessions share it):** a ≥65-min branch silence triggers only a
READ-ONLY independent review + an alert — it does **NOT** transfer PR ownership. Driving another session's PR branch
requires an explicit handoff; absent that, open a **superseding branch that does not touch the original PR**.
