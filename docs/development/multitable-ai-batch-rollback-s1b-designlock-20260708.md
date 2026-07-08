# Multitable AI-fields S1b — true history-batch rollback (restore-surface extension) — DESIGN LOCK

状态：PROPOSED — 待 owner ratify

- **Slice**: S1b of the AI-fields governance arc (S1 provenance/grouping foundation ✅ → **🔒 S1b true history-batch rollback ← this lock** → S2 prompt-config-history UI → S3 staleness lineage → S4 cost visibility → S5 cleaning kinds).
- **Baseline SHA**: every `file:line` below is verified at `origin/main` `0964908662eb2ea4d87d2d3153fd3c3f7ffaa057` (the merge commit of #3921). Re-verify before any implementation opt-in; `univer-meta.ts` line numbers in particular drift under the `[MUTEX:BE]` traffic (§7).
- **Scope**: docs-only. One file, zero runtime change. This lock designs — it does not authorize — a batch-scoped record revert that reverts each member of a commit-action batch to its own pre-batch value. Every rung in §8 is a **separate** owner opt-in.

---

## §0 Premise verdict up front — **NARROWER, not FALSE, not BLOCKED**

S1 §R2 hands S1b five deliverables: (1) batch-scoped revert, (2) per-record predecessor targeting, (3) preview-identity shape, (4) partial-outcome semantics, (5) a History Center write entry (its own owner opt-in). Verifying each against code:

| Sub-claim (S1 §R2 / §R1) | Verdict | Evidence |
|---|---|---|
| S1's grouping key shipped (a batch id exists to scope over) | **TRUE** | `record-write-service.ts:669` (`bulkBatchId = batchId ?? randomUUID()`), `multitable-ai.ts:1150/1417` (one `randomUUID()` per commit request), `:1649` (passed into `commitOneRecord`), migration `zzzz20260619120000_add_meta_record_revisions_batch_id.ts:16` (`batch_id` column live) |
| Today's restore surface CANNOT revert a batch | **TRUE** | `restore-batch-preview`/`-execute` take ONE shared `targetVersion` + a `recordIds[]` set (`univer-meta.ts:8891`, `:9355`); no `batchId` input, no per-record predecessor. It restores a record SET to version N, not "undo this batch" |
| History Center is read-only | **TRUE** | `HistoryCenterModal.vue:4` ("Read-only: no restore here (T5/T6 are gated)"); no restore action wired at its mount `MultitableWorkbench.vue:533` |
| S1 §R1(ii): "every member revision carries its own version chain sufficient to derive per-record predecessor targets" | **NARROWER — this is the headline** | The revision log's `version` counter is **shared with write paths that bump version but emit NO revision** (§2). So a batch member's true immediate predecessor may occupy a version that has no revision row. The chain is sufficient **only when reverting fields whose entire recent history was written by the revision-emitting spine**. Stated as-is, S1 §R1(ii) over-claims |

Because sub-claims 1–4 hold and the only defect is a **narrowing of the soundness envelope** (fenceable, not fatal), the correct action is to **write the lock and make the narrowing its headline** — not to STOP. Writing no lock would bury the single most valuable finding of this slice. §2 is that finding.

---

## §1 What actually shipped (S1 runtime, verified)

- The AI bulk-commit and job-commit routes mint one `randomUUID()` per commit request (`multitable-ai.ts:1150`, `:1417`) and thread it through `commitOneRecord` (`:1586`) into `patchRecords` via `RecordPatchInput.batchId` (`:1649`). The write spine stamps it onto every member revision (`record-write-service.ts:669` → `:1001`), defaulting to a fresh id per call otherwise — byte-identical for non-AI callers.
- Members carry `source='ai-shortcut'` (`multitable-ai.ts:539`, `:1648`; union member `post-commit-hooks.ts:4`); a restore writes `source='restore'` (never bleeds AI attribution — S1 A4).
- Read-side grouping already exists: `history-projection.ts` groups by `COALESCE(batch_id, id)` and exposes batch detail (`loadHistoryBatchDetail`, `history-projection.ts:586`), permission-filtered (row layer `:611`, field layer, null when fully denied `:620`/`:661` — no existence oracle).

So the grouping key S1b scopes over is real and durable. The foundation holds.

---

## §2 THE HEADLINE — per-record predecessor targeting is version-gapped

**To revert record R (a batch member at version V) to its pre-batch value, S1b needs R's state immediately BEFORE the batch touched it.** A member revision's own `snapshot` column is the POST-write state (after-image); the predecessor lives in an earlier revision. Two code facts make naive predecessor resolution unsound:

### 2.1 The version counter is shared; not every version has a revision

`meta_records.version` and `meta_record_revisions.version` are the **same** monotonic counter. But multiple **user-data** write paths bump `version` while emitting **no** revision row (they are not on the revision-writing spine — the spine is `record-write-service.patchRecords` / `record-service` / PIT undelete-reset only). Verified non-spine version-bumping user-data writers:

| Writer | file:line | Bumps version | Emits revision |
|---|---|---|---|
| automation `update_record` | `automation-executor.ts:2163` | ✓ | **✗** |
| automation `resultWriteback` | `automation-service.ts:2793` | ✓ | **✗** |
| plugin-SDK `patchRecord` | `records.ts:489` | ✓ | **✗** |
| public-form submit edit | `univer-meta.ts:13957` | ✓ | **✗** |
| attachment-delete record edit | `univer-meta.ts:15185` | ✓ | **✗** |

(Design-intent corroboration: `RecordRevisionSource` reserves `'automation' | 'public-form' | 'plugin'` enum positions `record-history-service.ts:10`, and #3921's audit §3 records that public-form and plugin emit zero revisions today.)

**Consequence.** A record at live version 10 may have revisions only at {3, 5, 7, 10}; versions {4, 6, 8, 9} were consumed by automation/plugin/form writes that left no revision. If an AI batch wrote R at version 10, R's true predecessor state is **version 9** — which has no revision row.

### 2.2 The two candidate resolvers diverge, and the wrong one silently clobbers

- **Exact `member.version − 1` resolver (SOUND, fail-closed):** query the revision with `version = V − 1`. If it does not exist (version 9 was a non-revision write), return `predecessor_unavailable` → that member is skipped, disclosed. Never clobbers.
- **Nearest-prior resolver `loadPreviousSnapshots` (UNSOUND for revert):** `history-projection.ts:551` is documented to return "the nearest surviving prior revision, **not `version − 1`**" (`:546`), via `WHERE ... version < t.version ORDER BY version DESC LIMIT 1` (`:563`). For R at version 10 it returns the version-7 snapshot — silently **skipping the writes at versions 8 and 9**. Reverting to it clobbers those writes with no signal. `loadPreviousSnapshots` is **correct for read-display** (showing a before/after diff in History Center) but **wrong as a revert target**.

**This is the load-bearing anti-requirement.** S1b MUST introduce a **new** predecessor resolver keyed on **exact `member.version − 1`**, fail-closed to `predecessor_unavailable`, and MUST NOT reuse `loadPreviousSnapshots`. (§8 R1 names the exact RED mutation.)

### 2.3 The revert target is field-scoped, not a whole-record restore

The revert must apply `pick(snapshot_{V−1}, member.changed_field_ids)` — restore **only the fields this batch member changed**, with `unset` for fields absent at V−1 (created by the batch). It must NOT restore the full V−1 snapshot the way BS-3 does (`computeRecordRestoreDiff` over the whole target snapshot, `univer-meta.ts:9412`), because a full-snapshot restore would clobber unrelated fields edited AFTER the batch. This is a **new diff shape**, not a reuse of BS-3 — a reviewer must not assume the BS-3 full-record restore is being reused.

---

## §3 Seam vs the four live artifacts (do not duplicate, do not contradict)

| Artifact | State | What it owns | What S1b owns (the seam) |
|---|---|---|---|
| **#3922** 4c-1 lossy retype revert | OPEN | **Config/schema** revert of a field's type/property, lossy-value oracle. Edits `restore-preview-identity.ts`, `restore-caps.ts`, `lossy-retype-oracle.ts`, `univer-meta.ts` | S1b is a **record-data** revert (record values), not schema. Different revert axis. **File collision only on `restore-preview-identity.ts`** — both add claim types (§7) |
| **#3921** 4c-2 destruction-path gap audit | **MERGED** (= this baseline HEAD) | The finding that automation/plugin **hard-delete** paths (`automation-executor.ts:2269`, `records.ts:565`) write no delete revision → PIT reconstruction (`record-reconstructor.ts:51`) lies a deleted record is alive | S1b inherits this as a **predecessor-destruction fork** (§4). Its owner menu item **D-1** (emit delete revisions) is a cross-lane fix S1b MUST NOT make |
| **#3928** cross-page grouping data-model lock | OPEN (PROPOSED) | `view-groups` server-side grouping route + grid `[MUTEX]` on `MetaGridTable.vue` / `useMultitableGrid.ts` | Disjoint feature. Shares the backend hot file `univer-meta.ts` under `[MUTEX:BE]` (§7) |
| **#3931** non-grid view materialization lock | OPEN (PROPOSED) | Defines the **`[MUTEX:BE]`** class over `univer-meta.ts` + `aggregation-helpers.ts` + `api/client.ts` (its §5.0-C) and `[MUTEX:WB]` over `MultitableWorkbench.vue` (its §5.0-B) | S1b's backend + wire rungs fall inside `[MUTEX:BE]`; its FE rung inside `[MUTEX:WB]`. S1b **honors** both, baseline-first (§7) |

**Note on #3921's title.** The alleged defect ("only 1 of 4 delete paths covered; PIT pollution") is about **existence** reconstruction on the DELETE axis — it does **not** show predecessor reconstruction is broken. The predecessor unsoundness (§2) is a **different**, independently-found defect on the UPDATE axis. #3921's gap therefore does not trigger this task's STOP condition; it feeds one fork into §4.

---

## §4 The predecessor-destruction fork (handed to a gated rung, not papered over)

#3921 established that automation `delete_record` (`automation-executor.ts:2269`) and plugin-SDK `deleteRecord` (`records.ts:565`) **hard-DELETE** the row and write **no** delete revision. This forks S1b's predecessor targeting:

- A record R that was an AI batch member (so it has a member revision) can later be **hard-deleted** by automation/plugin. The row is gone from `meta_records`, but its revisions REMAIN in `meta_record_revisions` (delete didn't clean them, and no delete revision was written).
- A batch revert of a batch containing R will attempt to write R. Because R's row is gone, the spine's `WHERE id=$1` matches zero rows → `RecordNotFoundError` (`record-write-service.ts:801`) → **per-record skip** in the partial model (§5). That is the safe outcome — **provided the revert's diff base is LIVE `meta_records` data.**
- The trap: if any resolver instead used PIT reconstruction (`reconstructRecordsAtT`, `record-reconstructor.ts:51`) as the diff base, it would see R as **still alive** (the #3921 pollution) and could resurrect a phantom or clobber. **Anti-requirement (§8 R2/R3):** predecessor resolution and the revert write MUST take their base state from live `meta_records` rows (as BS-3 does at `univer-meta.ts:9412` `liveById`), NEVER from `reconstructRecordsAtT`.
- **Honest signal is BLOCKED, not built.** Distinguishing "this member's record was destroyed by automation" from "this member is row-denied to you" would require automation/plugin to emit delete revisions — that is #3921's **D-1**, a cross-lane change to the automation line. S1b MUST NOT make it. The rung that would surface a destroyed-vs-denied signal (§8 R6) is therefore **gated on D-1 landing elsewhere**; until then S1b discloses `predecessor_unavailable` / skip without a destruction/denial distinction (parity with the existing no-oracle posture, `history-projection.ts:611`).

---

## §5 S1b revert semantics (the design)

**Contract.** `batchRevert(sheetId, batchId)` reverts each **visible** member of the batch to `pick(predecessor_{member}, member.changed_field_ids)`, where `predecessor_{member}` is the exact-`(version − 1)` revision snapshot (§2.2), fail-closed to skip when unavailable. It is **PARTIAL by default** (each member its own write), **forward-only** (`source='restore'`; never a destructive delete — parity with BS-3's forward-only posture).

**Preview identity (reuse the repo's dry-run→apply revision-hash fence vocabulary — do not mint new terms).** The repo already fences scoped restore with a signed identity minted over the exact computed set and re-verified before any write: `mintScopedRestorePreviewIdentity` / `verifyScopedRestorePreviewIdentity` (`restore-preview-identity.ts:148`/`:163`), `hashScope` over `{recordId, changesHash, version}` (`:127`), verified BEFORE any 2xx with 410-on-expired / 409-on-mismatch (`univer-meta.ts:9428`/`:9433`). S1b adds a **`BatchRevertPreviewIdentityClaims`** binding `{sheetId, batchId, scopeHash(perMember{recordId, predecessorChangesHash, version}), actorId}`. `strategy` today is a closed literal `'revert'` (`restore-preview-identity.ts:35`/`:109`); S1b's claim type is a sibling, additive. **Preview-identity contract: the previewed set equals the applied set** — a member whose live data or version drifted between preview and apply re-hashes → whole-batch 409 → re-preview (the BS-3 diff-level rule).

**Partial-outcome semantics (the crux — LOCK-12 `partialSuccess`).** A batch revert of N members where k fail:
- **Two-layer rejection, exactly the BS-3 split** (`univer-meta.ts:9355` header): **DIFF-LEVEL** (a member now missing / no-predecessor / drifted since preview) → excluded → recomputed `scopeHash` diverges → **whole-batch 409, re-preview** (never silently apply a smaller set than the token authorized). **WRITE-LEVEL** (row-deny appeared / version conflict / field-forbidden at apply) → **per-member skip + report**, batch proceeds.
- **The concurrency hazard, named:** a concurrent edit to member R between preview and apply moves R's version → R's cached predecessor is now stale relative to a newer write. The in-transaction CAS (`expectedVersion` under `SELECT FOR UPDATE`, `record-write-service.ts:835`) fires: version moved → conflict → R **skipped** (partial), never clobbered. The user sees `restoredCount` / `skippedCount` + per-member reason, identical vocabulary to BS-3's outcome shape.
- **What is persisted:** exactly the members that both survived the identity re-verify AND passed the apply-time CAS + permission gates. Nothing else. The response states which members were skipped and why.
- **Preview-identity = applied set:** because the identity is minted over the recomputed contributing set and re-verified before any write, the preview the user approved is provably the set applied (modulo write-level partial skips, which are disclosed).

---

## §6 Permission parity — by CITATION, never invention (never touch central rbac/auth — K3)

A batch revert is a **record WRITE**. It MUST route through the existing multitable write gates, not a new authority:

- **Sheet-level write gate:** `ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'edit')` (`sheet-capabilities.ts:307`) — the same gate `patchRecords` enforces at `record-write-service.ts:812` and BS-3 relies on. The revert route gates on `canEditRecord` (as BS-3 does, `univer-meta.ts:9362` region).
- **Field-write gate (layer-3):** `isFieldWriteForbidden(perm)` (`permission-derivation.ts:114`) + static readonly `isFieldAlwaysReadOnly` (`:58`, covers formula/lookup/rollup/`SYSTEM_FIELD_TYPES` `field-codecs.ts:1114`/mirror). BS-3 gates the whole record on this (`univer-meta.ts:9440`); S1b MUST apply the identical predicate so a visible-but-readOnly field is never written.
- **Row-read-deny:** `loadRowLevelReadDenyEnabled` (`permission-service.ts:917`) + `loadDeniedRecordIds` (`:1121`) — a member the actor cannot read is dropped from the visible set (parity with `history-projection.ts:611` and BS-3's `deniedIds`), sharing ONE `'unavailable'` reason with "missing" (no existence oracle).

**Required golden (fail-closed):** a revert that would write a record the actor cannot write MUST fail closed; a batch containing one such member MUST NOT partially apply **without disclosing** that member as skipped-with-reason. (§8 R3 names the RED mutation.) All of the above are **multitable-local primitives** — central rbac/auth is untouched (K3 red line).

---

## §7 Mutex declaration (every single-occupancy hot file)

| Class | Files | Owner-defining lock | S1b rungs tagged | Cannot run concurrently with |
|---|---|---|---|---|
| **`[MUTEX:BE]`** | `packages/core-backend/src/routes/univer-meta.ts`, `apps/web/src/multitable/api/client.ts` (both named in #3931 §5.0-C) | #3931 §5.0-C | R2, R3 (new routes in `univer-meta.ts`), R4 (wire types in `api/client.ts`) | #3931 slices **D/G**, #3928 slices **A/B**. Baseline-first: only one route PR in flight on `univer-meta.ts`; the later starter rebases to the earlier's head and **re-verifies every `:9xxx`/`:8xxx` citation** (they WILL drift) |
| **`[MUTEX:WB]`** | `apps/web/src/multitable/views/MultitableWorkbench.vue` (#3931 §5.0-B) | #3931 §5.0-B | R4 (mount the revert dialog), R5 (History Center write entry) | any other `[MUTEX:WB]` slice (#3931 B/C/E/F/G); not two at once |
| **`[MUTEX:PID]` (S1b↔#3922, file-level — NOT part of `[MUTEX:BE]`)** | `packages/core-backend/src/multitable/restore-preview-identity.ts` | this lock | R3 (adds `BatchRevertPreviewIdentityClaims` + mint/verify) | **#3922** (which also edits `restore-preview-identity.ts`). Additive on both sides, but same file — the later starter rebases and re-reads `:35`/`:127`/`:163` |
| **grid `[MUTEX]`** | `MetaGridTable.vue`, `useMultitableGrid.ts` | #3928 §5.0 | **none** — S1b touches neither. Stated to prove S1b is disjoint from the grid lock |

**Deliberate isolation choice:** the new predecessor resolver (§2.2) lands in a **new file** (e.g. `batch-revert-resolver.ts`), NOT in `history-projection.ts`, so S1b does not add a fourth occupant to the history hot file and its resolver stays provably distinct from `loadPreviousSnapshots`.

---

## §8 Gated ladder (each rung a separate owner opt-in; ratify ≠ unlock R1; R1 land ≠ unlock R2)

Flags introduced (both default OFF, naming parity with `MULTITABLE_ENABLE_*`): **`MULTITABLE_ENABLE_BATCH_REVERT`** (core), **`MULTITABLE_ENABLE_HISTORY_CENTER_REVERT`** (R5, the History Center write entry — separate per S1 §R2).

| # | Rung | unblockedBy | Files / mutex | Model | Verification (named) | Exact mutation that MUST go RED |
|---|---|---|---|---|---|---|
| **R0** | this design lock | — | 1 doc | opus draft | grep doc+PR body: zero external-product names; §2 headline present | — |
| **R1** | **Predecessor resolver** (pure, new file): `resolvePredecessor(sheetId, recordId, memberVersion)` → exact `version − 1` revision snapshot; fail-closed `predecessor_unavailable` when absent. **Field-scoped target** = `pick(snapshot_{V−1}, changed_field_ids)` w/ `unset` for absent (§2.2/2.3) | R0 ratify | new `batch-revert-resolver.ts` — **no mutex** | sonnet impl / opus review | unit: a record with revisions at {3,5,7,10} + a non-revision automation write at v9 (fixture) → predecessor of the v10 member is **`predecessor_unavailable`** (NOT the v7 snapshot) | swap the exact-`v−1` lookup for `loadPreviousSnapshots` (nearest-prior) → the "automation-write-at-v9-is-not-clobbered" unit assertion goes RED |
| **R2** | **Batch-revert PREVIEW route** (read-only): `POST /sheets/:sheetId/batch-revert-preview` — resolves each visible member's predecessor via R1, computes the field-scoped diff vs LIVE data, mints `BatchRevertPreviewIdentity` over the contributing set. Discloses skipped members + reason. Row/field masking parity (§6) | R1 | `univer-meta.ts` **`[MUTEX:BE]`**, `restore-preview-identity.ts` **`[MUTEX:PID]`** | sonnet impl / opus review | real-DB golden (new db, file-namespaced fixture ids, `afterAll` cleanup): batch of 3 members, one row-denied to actor → preview returns 2 restorable + 1 `unavailable`; identity `scopeHash` binds exactly the 2 | drop the `deniedIds` filter before minting → the golden's "denied member excluded from scopeHash" assertion goes RED |
| **R3** | **Batch-revert EXECUTE route** (the WRITE): `POST /sheets/:sheetId/batch-revert-execute` — verify identity BEFORE any write; DIFF-level drift → whole-batch 409; WRITE-level (deny/conflict/forbidden) → per-member skip+report; partial by default; **live-data base only, never `reconstructRecordsAtT`**; permission parity §6 | R2 | `univer-meta.ts` **`[MUTEX:BE]`**, `restore-preview-identity.ts` **`[MUTEX:PID]`** | sonnet impl / opus review | real-DB golden: (a) fail-closed — a member on a field the actor cannot write ⇒ that member skipped-with-reason, batch discloses it, that field NOT written; (b) concurrency — edit a member between preview and apply ⇒ CAS conflict ⇒ that member skipped, others applied; (c) hard-deleted member (automation delete, no row) ⇒ skipped, no resurrection | (a) remove the `isFieldWriteForbidden` pre-write gate ⇒ fail-closed assertion RED; (c) swap the live-`meta_records` diff base for `reconstructRecordsAtT` ⇒ the "hard-deleted member is not resurrected" assertion goes RED |
| **R4** | **FE revert surface + wire**: a batch-revert dialog (preview → confirm → apply, showing restorable/skipped) mounted in the workbench; `api/client.ts` wire methods. Flag-derived capability (server truth), hidden when `MULTITABLE_ENABLE_BATCH_REVERT` off | R3 | `MultitableWorkbench.vue` **`[MUTEX:WB]`**, `api/client.ts` **`[MUTEX:BE]`**, new dialog component | sonnet impl / opus review | mount test: preview response {restorable:2, skipped:1} ⇒ dialog lists 2 appliable + 1 skipped-with-reason; apply calls execute once; flag off ⇒ entry not rendered | make the confirm button ignore the skipped list and submit all member ids ⇒ "only restorable members submitted" assertion RED |
| **R5** | **History Center write entry** (S1 §R2: "its own owner opt-in") — lift the read-only posture ONLY behind **`MULTITABLE_ENABLE_HISTORY_CENTER_REVERT`** (default off): a "revert this batch" action inside `HistoryCenterModal` that calls R3. Read-only posture (`HistoryCenterModal.vue:4`) is preserved when the flag is off | R4 **AND** explicit owner opt-in | `HistoryCenterModal.vue`, `MultitableWorkbench.vue` **`[MUTEX:WB]`** | sonnet impl / opus review | mount test: flag off ⇒ History Center renders NO revert control (byte-identical to today, `:4` posture intact); flag on + actor with write ⇒ control present and routes to R3 | render the revert control unconditionally (ignore the flag) ⇒ "flag-off = no control" assertion RED |
| **R6** | **Destroyed-vs-denied honest signal** — surface why a member is `unavailable` (destroyed by automation/plugin vs row-denied). **BLOCKED**: requires #3921 **D-1** (automation/plugin emit delete revisions) to land on the automation line first. S1b MUST NOT make that cross-lane change | #3921 **D-1** merged elsewhere **AND** owner opt-in | (deferred) | — | (defined when unblocked) | — |

---

## §9 Explicitly OUT of S1b (each a separate gated opt-in)

- **Destructive undo** (deleting records the batch created rather than reverting field values) — S1b is forward-only, parity with BS-3; a create-then-delete undo is a separate hard-gated slice.
- **All-or-nothing batch revert** — S1b is PARTIAL by default; the transactional mode is a small follow-up behind a named need (as BS-3.1 was to BS-3), not built speculatively.
- **Cross-base batch revert**, **automation/form/attachment write-path revision backfill** (that is #3921 D-1, cross-lane), **whole-run aggregate revert across multiple batches**, **audit-grade run↔batch persistence** (S1 B6 froze it), **reverting a batch member whose predecessor is unavailable by reconstructing from PIT** (unsound per §4 — deliberately excluded).

---

## §10 Arc ledger (update)

- ✅ **S1** AI write provenance + commit-action batch grouping (rollback foundation) — RATIFIED + IMPLEMENTED (#3569/#3584)
- 🔒 **S1b** true history-batch rollback — **this lock (PROPOSED)**. Core R1–R4 behind `MULTITABLE_ENABLE_BATCH_REVERT`; History Center write entry R5 behind `MULTITABLE_ENABLE_HISTORY_CENTER_REVERT`; R6 blocked on #3921 D-1
- ⬜ **S2** prompt-as-audited-config UI · 🔒 **S3** staleness lineage · 🔒 **S4** cost visibility · 🔒 **S5** normalize kind
