# Multitable AI write provenance + commit-action batch grouping (rollback FOUNDATION) — S1 DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Docs-only PR; no runtime code ships here.
- **Slice**: S1 of the AI-fields governance arc (S1 provenance/grouping foundation → 🔒 S1b true history-batch rollback → S2 prompt-config-history UI → S3 staleness lineage → S4 cost visibility → S5 cleaning-oriented kinds).
- **What S1 is NOT**: S1 makes **no rollback claim**. Today's restore surface cannot revert a history batch (see §4); batch-shaped revert is S1b, a separate gated design. S1 delivers the attribution + grouping that S1b (and history legibility today) require.
- **Change surface when implemented** (single runtime PR after ratification): `post-commit-hooks.ts` (`RecordWriteSource` union), `record-write-service.ts` (`patchRecords` input + batch minting), `routes/multitable-ai.ts` (three write paths), History Center source label (inline map, see A5). **No new tables, no migrations, no new env flags, no restore-surface change.**

## §1 Problem (verified at line level)

1. **AI writes are unattributed.** All AI write paths call `patchRecords` without `source`, which defaults to `'rest'` (`record-write-service.ts:959`): the inline shortcut run (`routes/multitable-ai.ts:523`) and both bulk-commit and job-commit, which share `commitOneRecord` (`routes/multitable-ai.ts:1566` → `patchRecords` at `:1607`). In Global History an AI fill is indistinguishable from a manual edit.
2. **No commit-shaped history unit.** `patchRecords` mints `bulkBatchId` per CALL (`record-write-service.ts:750-753`, LOCK-12: "one bulk patchRecords call = one user action = one batch"), while AI bulk/job commit is per-row `commitOneRecord` (`routes/multitable-ai.ts:1145-1161`) — so N confirmed rows land as N unrelated single-row batches. History Center then shows one AI commit as N scattered rows (illegible today), and a future batch-shaped revert (S1b) has no grouping key to scope over.

The revision insert layer already accepts a caller batch id (`RecordRevisionInput.batchId`, `record-history-service.ts:12` with the LOCK-12 comment); the missing seam is at the `patchRecords` input.

## §2 LOCK-A — source attribution (`ai-shortcut`)

- **A1**: `RecordWriteSource` (`post-commit-hooks.ts:4`) gains `'ai-shortcut'`. `RecordRevisionSource` is already open (`… | string`, `record-history-service.ts:10`) — no change there.
- **A2**: all three AI write paths pass `source: 'ai-shortcut'` — the inline run call site, and the shared `commitOneRecord` call site (covers bulk-commit and job-commit at once).
- **A3**: revisions are written ONLY by the write spine (`record-write-service`). The AI route never inserts revisions directly. (Same spine discipline as the cross-base C2 Lock-A.)
- **A4**: restoring an AI batch writes its revisions with `source: 'restore'` — attribution never bleeds through restore.
- **A5**: FE — History Center's `sourceLabel` is today an INLINE zh/en map inside `HistoryCenterModal.vue:133` (unknown sources fall back to the raw string, so `ai-shortcut` would render un-translated but functional). Runtime extends that inline map with an `ai-shortcut` entry; if a second component ever needs the map, extract it into a shared helper THEN. No claim of an existing shared label module (`batch-restore-labels.ts` is unrelated record-title capture).

## §3 LOCK-B — commit-action batch semantics

- **B1**: new OPTIONAL write-spine seam **`RecordPatchInput.batchId?: string`**. Absent → behavior byte-identical to today (per-call `randomUUID` at `record-write-service.ts:750`). Present → used as the shared batch id for every row written by the call.
- **B2**: LOCK-12 semantic extension, recorded here: **"one COMMIT ACTION = one batch"** — a commit action MAY span multiple per-row `patchRecords` calls that pass the same server-minted `batchId`. The per-call default remains the base case for every other caller.
- **B3**: the AI bulk-commit and job-commit routes mint ONE `randomUUID` batch id per COMMIT REQUEST and pass it into every `commitOneRecord` of that request. Two commit requests on the same job → two batches (**the grouping unit = the commit action**, consistent with LOCK-2 batch-as-primary-UX-unit; this is also the unit a future S1b revert would scope over). The inline single-cell run passes NO batchId (a single-row action stays its own batch).
- **B4**: `batchId` is **server-minted only**. Any client-supplied batch id in a request body is ignored — the seam is an internal service input, never an API field (untrusted-browser rule).
- **B5**: batch sharing is **attribution-only grouping**. The per-row commit discipline is unchanged and explicitly protected: commit-time re-gate, cached `previewVersion` as `expectedVersion` (anti-TOCTOU), per-row outcome vocabulary (`not_in_cache` / `skipped_no_perm` / stale-drop / committed), actor-bound preview cache (`routes/multitable-ai.ts:1130-1140`). **No single-transaction merge** — a shared batch id must not change any outcome shape. (BJ-contract preservation.)
- **B6**: **no runId persistence in v1.** `meta_record_revisions` surface is FROZEN for this slice (`record-history-service.ts:12`: id/version/action/source/actor/changedFieldIds/patch/snapshot/batchId — no metadata column). Commit responses gain `batchId` so callers can map run→batch ephemerally; the job tables already carry jobId→rows. Audit-grade run↔batch persistence = a separate gated slice with its own migration + redaction/retention treatment.

## §4 Restore interaction — why S1 makes NO rollback claim

**Today's restore surface cannot revert a history batch** (verified):

- Single-record restore-execute takes `(recordId, targetVersion, expectedVersion, previewIdentity, fieldIds?)` (`api/client.ts:2154-2164`) — one record, one explicit target version.
- Scoped/batch restore (BS-2 preview / BS-4 execute) takes `recordIds[] + ONE shared targetVersion (+ per-record expectedVersions)` (`univer-meta.ts:8611` zod schema) — "restore these records to version N", NOT "revert this batch". It has **no batchId input** and **no per-record predecessor targeting** (reverting a batch requires each record to return to its OWN pre-batch version, which differs per record).
- History Center is explicitly read-only ("no restore here — T5/T6 are gated", `HistoryCenterModal.vue:1-6`).

Therefore:

- **R1 (S1 guarantees, restore-facing)**: S1 delivers exactly the FOUNDATION a future batch revert needs — (i) all rows of one AI commit action share one `batch_id`; (ii) every member revision carries its own version chain (`version`/`patch`/`snapshot`) sufficient to derive per-record predecessor targets; (iii) `source='ai-shortcut'` distinguishes AI batches. Nothing in S1 touches the restore routes.
- **R2 (🔒 S1b, separate gated design-lock)**: true history-batch rollback = a restore-surface extension — batch-scoped revert with per-record predecessor targeting, its preview-identity shape, partial-outcome semantics, and a History Center write entry (lifting its read-only posture is its own owner opt-in). None of it is promised by S1.
- **R3 (provable today)**: attribution never bleeds through restore — restoring a record that an AI batch touched writes revisions with `source='restore'` (A4), testable with the EXISTING single-record restore route.

## §5 Golden matrix (fail-first, real-DB)

| # | Scenario | Locked outcome |
| --- | --- | --- |
| G1 | inline shortcut run writes a cell | revision `source='ai-shortcut'`, single-row batch |
| G2 | bulk-commit N confirmed rows in one request | N revisions share ONE `batch_id`; history projection shows ONE batch with N changes, source `ai-shortcut` |
| G3 | job commit with mixed outcomes (committed / not_in_cache / skipped_no_perm / stale-drop) | only committed rows join the batch; outcome vocabulary and per-row shapes unchanged |
| G4 | two commit requests on the same job | two distinct batches |
| G5 | READ-side grouping: job commit spanning multiple per-row `patchRecords` calls (multiple transactions) | history projection returns ONE batch containing exactly the committed rows' changes; batch detail lists all N |
| G5b | single-record restore-execute (EXISTING route) on a record last written by an AI batch | succeeds; the restore revision carries `source='restore'`, never `ai-shortcut` (A4/R3) |
| G6 | non-AI callers | `batchId` absent → per-call random id; existing patchRecords goldens stay green |
| G7 | client-supplied batchId in an AI commit request body | no effect (server-minted only) |
| G8 | FE label | History Center's inline `sourceLabel` map renders the `ai-shortcut` entry (render test); unknown-source fallback behavior unchanged |

## §6 Explicitly OUT of S1 (each a separate gated opt-in)

**S1b true history-batch rollback** (restore-surface extension: batch-scoped revert + per-record predecessor targeting + History Center write entry — design-lock-first, owner opt-in), classify→select target ring (**deliberately excluded** — it would dilute this PR's core contract), S2 prompt-config-history UI, S3 staleness lineage, S4 cost-visibility polish, S5 normalize kind, confidence gating, structured-extract / dedupe-assist kinds, whole-run aggregate revert UI, runId persistence on revisions.

## §7 Rollout

No new env flag: the AI write paths already sit behind the A1 readiness + `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` double-confirm gate, and this slice's changes are metadata-correctness with default-identical spine behavior for every other caller. Implementation lands with the full §5 golden matrix in one runtime PR after ratification.

## §8 Arc ledger

- ⬜ **S1** AI write provenance + commit-action batch grouping (rollback foundation) — **this lock**
- 🔒 **S1b** true history-batch rollback (restore-surface extension; design-lock-first; History Center write entry = its own owner opt-in)
- ⬜ **S2** prompt-as-audited-config UI (backend already records `field.property` diffs into `meta_config_revisions`, `config-revision-recorder.ts`; S2 renders the `aiShortcut` diff human-readably)
- 🔒 **S3** staleness lineage (design-first: state storage + no-auto-recompute UX)
- 🔒 **S4** cost visibility polish (estimate UI + per-field/per-run usage dimensions)
- 🔒 **S5** normalize kind (cleaning arc first cut) · 🔒 rider: classify→select
