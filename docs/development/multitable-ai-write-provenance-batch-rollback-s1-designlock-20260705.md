# Multitable AI write provenance + batch rollback semantics — S1 DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Docs-only PR; no runtime code ships here.
- **Slice**: S1 of the AI-fields governance arc (S1 provenance/rollback → S2 prompt-config-history UI → S3 staleness lineage → S4 cost visibility → S5 cleaning-oriented kinds).
- **Change surface when implemented** (single runtime PR after ratification): `post-commit-hooks.ts` (`RecordWriteSource` union), `record-write-service.ts` (`patchRecords` input + batch minting), `routes/multitable-ai.ts` (three write paths), History Center source label via the existing typed label-module extension point. **No new tables, no migrations, no new env flags.**

## §1 Problem (verified at line level)

1. **AI writes are unattributed.** All AI write paths call `patchRecords` without `source`, which defaults to `'rest'` (`record-write-service.ts:959`): the inline shortcut run (`routes/multitable-ai.ts:523`) and both bulk-commit and job-commit, which share `commitOneRecord` (`routes/multitable-ai.ts:1566` → `patchRecords` at `:1607`). In Global History an AI fill is indistinguishable from a manual edit.
2. **No whole-commit rollback unit.** `patchRecords` mints `bulkBatchId` per CALL (`record-write-service.ts:750-753`, LOCK-12: "one bulk patchRecords call = one user action = one batch"), while AI bulk/job commit is per-row `commitOneRecord` (`routes/multitable-ai.ts:1145-1161`) — so N confirmed rows land as N unrelated single-row batches. Tagging `source` alone yields attribution but no run-shaped revert unit.

The revision insert layer already accepts a caller batch id (`RecordRevisionInput.batchId`, `record-history-service.ts:12` with the LOCK-12 comment); the missing seam is at the `patchRecords` input.

## §2 LOCK-A — source attribution (`ai-shortcut`)

- **A1**: `RecordWriteSource` (`post-commit-hooks.ts:4`) gains `'ai-shortcut'`. `RecordRevisionSource` is already open (`… | string`, `record-history-service.ts:10`) — no change there.
- **A2**: all three AI write paths pass `source: 'ai-shortcut'` — the inline run call site, and the shared `commitOneRecord` call site (covers bulk-commit and job-commit at once).
- **A3**: revisions are written ONLY by the write spine (`record-write-service`). The AI route never inserts revisions directly. (Same spine discipline as the cross-base C2 Lock-A.)
- **A4**: restoring an AI batch writes its revisions with `source: 'restore'` — attribution never bleeds through restore.
- **A5**: FE — History Center (`HistoryCenterModal.vue`) renders a distinct label for the `ai-shortcut` source through the EXISTING typed label-module extension point (history/batch label module, e.g. `batch-restore-labels.ts`); extend the module, never redeclare helpers (i18n discipline).

## §3 LOCK-B — commit-action batch semantics

- **B1**: new OPTIONAL write-spine seam **`RecordPatchInput.batchId?: string`**. Absent → behavior byte-identical to today (per-call `randomUUID` at `record-write-service.ts:750`). Present → used as the shared batch id for every row written by the call.
- **B2**: LOCK-12 semantic extension, recorded here: **"one COMMIT ACTION = one batch"** — a commit action MAY span multiple per-row `patchRecords` calls that pass the same server-minted `batchId`. The per-call default remains the base case for every other caller.
- **B3**: the AI bulk-commit and job-commit routes mint ONE `randomUUID` batch id per COMMIT REQUEST and pass it into every `commitOneRecord` of that request. Two commit requests on the same job → two batches (**revert unit = the commit action**, consistent with LOCK-2 batch-as-primary-UX-unit). The inline single-cell run passes NO batchId (a single-row action stays its own batch).
- **B4**: `batchId` is **server-minted only**. Any client-supplied batch id in a request body is ignored — the seam is an internal service input, never an API field (untrusted-browser rule).
- **B5**: batch sharing is **attribution-only grouping**. The per-row commit discipline is unchanged and explicitly protected: commit-time re-gate, cached `previewVersion` as `expectedVersion` (anti-TOCTOU), per-row outcome vocabulary (`not_in_cache` / `skipped_no_perm` / stale-drop / committed), actor-bound preview cache (`routes/multitable-ai.ts:1130-1140`). **No single-transaction merge** — a shared batch id must not change any outcome shape. (BJ-contract preservation.)
- **B6**: **no runId persistence in v1.** `meta_record_revisions` surface is FROZEN for this slice (`record-history-service.ts:12`: id/version/action/source/actor/changedFieldIds/patch/snapshot/batchId — no metadata column). Commit responses gain `batchId` so callers can map run→batch ephemerally; the job tables already carry jobId→rows. Audit-grade run↔batch persistence = a separate gated slice with its own migration + redaction/retention treatment.

## §4 Restore interaction

- **R1**: T6 scoped restore must revert an AI batch that spans multiple `patchRecords` calls (and therefore multiple transactions) — the design assumption "restore is forward-writing per revision, no same-transaction dependency" is verified by golden G5, not assumed.
- **R2**: "undo the whole run" (aggregate multi-batch revert UI) is OUT of S1. The unit shipped here is per-commit-action; a later UI may aggregate a run's batches.

## §5 Golden matrix (fail-first, real-DB)

| # | Scenario | Locked outcome |
| --- | --- | --- |
| G1 | inline shortcut run writes a cell | revision `source='ai-shortcut'`, single-row batch |
| G2 | bulk-commit N confirmed rows in one request | N revisions share ONE `batch_id`; history projection shows ONE batch with N changes, source `ai-shortcut` |
| G3 | job commit with mixed outcomes (committed / not_in_cache / skipped_no_perm / stale-drop) | only committed rows join the batch; outcome vocabulary and per-row shapes unchanged |
| G4 | two commit requests on the same job | two distinct batches |
| G5 | T6 scoped restore over a multi-call AI batch | all its changes revert; re-run idempotent; restore revisions carry `source='restore'` (A4) |
| G6 | non-AI callers | `batchId` absent → per-call random id; existing patchRecords goldens stay green |
| G7 | client-supplied batchId in an AI commit request body | no effect (server-minted only) |
| G8 | FE label | History Center renders the `ai-shortcut` source label (label-module unit + render test) |

## §6 Explicitly OUT of S1 (each a separate gated opt-in)

classify→select target ring (**deliberately excluded** — it would dilute this PR's core contract), S2 prompt-config-history UI, S3 staleness lineage, S4 cost-visibility polish, S5 normalize kind, confidence gating, structured-extract / dedupe-assist kinds, whole-run aggregate revert UI, runId persistence on revisions.

## §7 Rollout

No new env flag: the AI write paths already sit behind the A1 readiness + `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` double-confirm gate, and this slice's changes are metadata-correctness with default-identical spine behavior for every other caller. Implementation lands with the full §5 golden matrix in one runtime PR after ratification.

## §8 Arc ledger

- ⬜ **S1** AI write provenance + batch rollback semantics — **this lock**
- ⬜ **S2** prompt-as-audited-config UI (backend already records `field.property` diffs into `meta_config_revisions`, `config-revision-recorder.ts`; S2 renders the `aiShortcut` diff human-readably)
- 🔒 **S3** staleness lineage (design-first: state storage + no-auto-recompute UX)
- 🔒 **S4** cost visibility polish (estimate UI + per-field/per-run usage dimensions)
- 🔒 **S5** normalize kind (cleaning arc first cut) · 🔒 rider: classify→select
