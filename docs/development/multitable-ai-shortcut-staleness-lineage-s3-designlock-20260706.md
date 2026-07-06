# Multitable AI-shortcut staleness lineage — flag-don't-auto-spend — S3 DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Runtime slice; needs ONE narrow migration (§3 LOCK-B, gated sub-decision).
- **Slice**: S3 of the AI-fields arc (S1 provenance ✅ → S2 prompt-config-history ✅ → **S3 staleness lineage (this)** → S4 cost visibility [#3673] → S5 normalize kind). Sibling contrast: **W1-1 formula freshness** (merged `26af7a560`) AUTO-recomputes formulas on write because it's cheap/deterministic; S3 does the OPPOSITE for AI outputs — **flag stale, never auto-recompute** — because an AI re-run costs money/tokens and hits a provider.
- **What S3 is NOT**: not auto-recompute of AI outputs (the entire point is to NOT silently spend); not a new AI kind; not the S4 cost surface (cross-ref #3673); not the DARK→GA lighting decision; not a write-path fan-out (see LOCK-D — staleness is read-time-derived, so an ordinary source edit does ZERO extra write work).

## §1 Problem (verified at line level, origin/main)

An `aiShortcut` field's output is DERIVED from its `sourceFieldIds` (`ai-shortcut-config.ts:27-29`, persisted at `field.property.aiShortcut`, `sourceFieldIds` is a non-empty declared array — the dependency declaration). When a source field's value later changes, the stored AI output is stale — but there is **no way to know it today**, and no safe way to act on it:

1. **The AI output is a plain cell value with no generation provenance.** An AI shortcut run/commit writes `result.text` straight into `meta_records.data[fieldId]` via `patchRecords` (`multitable-ai.ts:523-526`, `:1180`). Nothing is stored alongside it recording WHICH source values (or which version) it was generated against.
2. **`previewVersion` is not a durable anchor.** The preview cache stores `preview_version` = the RECORD version the proposal was generated against (`ai-bulk-preview-cache.ts:38,66`), used purely for anti-TOCTOU on the write (`expectedVersion`, `:1180`). It lives in the EPHEMERAL `multitable_ai_bulk_preview_cache` (30-min TTL sweep) and is a record version, not a source-value fingerprint — gone after the write settles.
3. **`formula_dependencies` does not cover aiShortcut deps.** That table (`univer-meta.ts:895-901,2817`) indexes formula field → depends-on-field for formula recompute; aiShortcut `sourceFieldIds` are a SEPARATE declaration in `field.property.aiShortcut`, not in it.

**Consequence**: therefore pure read-time derivation is impossible without a stored "generated-against" anchor — there is nothing durable to compare current source values against. S3 must store one small per-cell anchor. That anchor is the ONE new state this slice introduces (§3).

**Anti-footgun**: the naive fix (reuse W1-1's write-path fan-out to auto-recompute AI outputs) is EXACTLY WRONG — it would fire a provider call + drain the token budget on every source edit, invisibly. S3 deliberately forbids that (§4 LOCK-C).

## §2 LOCK-A — stale detection = server-side generation-fingerprint, derived on read

- **A1 (fingerprint at generation)**: when an AI shortcut writes its output (both the inline run `:523` and the bulk/job commit shared `commitOneRecord`), ALSO compute `sourceHash = sha256(canonical-ordered digest of the current values of `aiShortcut.sourceFieldIds`)` and persist it keyed to `(sheet_id, record_id, field_id)` (storage = §3). The hash is computed from the SAME source values the prompt was assembled from (`assembleMaskedPrompt`'s readable set), so it captures exactly what the output was derived from.
- **A2 (staleness is DERIVED on read)**: a cell is STALE iff `stored sourceHash` exists AND `≠ sha256(current source values)`. Computed at hydration/read time (where lookup/rollup are already computed-on-read), never stored as a mutable flag. **Self-healing**: a re-run rewrites the hash → stale clears automatically; a source edited back to its original value → not stale (hash matches again). No invalidation-cache drift possible.
- **A3 (no stored anchor ⇒ not stale)**: a cell with no `sourceHash` row (e.g. an AI field never run, or a legacy cell written before S3) is NOT stale — absence is "unknown provenance", never a false STALE. Fail-open on the BADGE (a missing badge is safe; the value is whatever it was), which is correct because staleness is advisory, not a security gate.

## §3 LOCK-B — storage (the ONE gated sub-decision: a narrow migration)

- **B1**: a NEW narrow table `multitable_ai_shortcut_generation (sheet_id text, record_id text, field_id text, source_hash text, generated_at timestamptz, PRIMARY KEY (sheet_id, record_id, field_id))`. One row per generated AI cell. **No change to any existing table.** Rows are overwritten on re-run (upsert), deleted on record/field delete (cascade or sweep), and a retention sweep can GC orphans cheaply (same discipline as the AI usage ledger / preview cache sweeps).
- **B2 (why a table, not a JSONB sibling key / not an existing store)**: the AI usage ledger is append-only + retention-swept (not a current-state store); the preview cache is ephemeral; stuffing the hash into `meta_records.data` as a sibling key would pollute the record payload + risk echoing into reads. A dedicated narrow table is the smallest clean anchor.
- **B3 (OWNER OPT-IN)**: this migration is the one piece of S3 that touches persistence. Ratifying this lock = greenlighting that one narrow table. If the owner would rather NOT add storage, S3 cannot ship as a visibility slice (there is no zero-storage way to know staleness — §1). This is stated plainly so the storage decision is explicit, not smuggled in.

## §4 LOCK-C — no-auto-recompute (the whole point)

- **C1**: a source field value change **NEVER triggers an AI provider call, never writes a usage-ledger row, never spends a token.** Staleness is passive — the badge simply appears on the next read. A source edit's write path is UNTOUCHED by S3 (see LOCK-D).
- **C2 (re-run is always explicit + priced + gated)**: clearing staleness requires an explicit user re-run through the EXISTING `/ai/shortcut/run` + bulk flow, which already: (a) surfaces the pre-run cost estimate (`conservativePromptTokenEstimate`; S4 #3673 makes this a first-class UI surface — cross-ref), (b) sits behind the `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` double-confirm gate, (c) books the charge in the usage ledger. S3 changes NONE of this — it only makes the "which cells are stale" set visible so the user can choose to re-run them.
- **C3 (golden-enforced)**: GS1 asserts a source edit leaves the usage ledger byte-untouched (zero new rows) — the anti-footgun is a locked, tested invariant, not a comment.

## §5 LOCK-D — read-time derivation, ZERO write-path fan-out

- **D1**: unlike formula freshness (W1-1, which fans out + recomputes on the write path), S3 needs **no fan-out on source edits**. Staleness is derived at read by comparing hashes, so an ordinary edit to a source field does zero extra work at write time. This is the big simplification and the reason S3 is low-risk on the hot write path.
- **D2 (transitivity is free, via values)**: because the hash is over source VALUES, a source that is itself a formula/aiShortcut recomputing to a NEW value changes the hash → the dependent AI cell correctly goes stale, at any depth, with no explicit cascade. What is OUT of v1 scope is config-change-without-value-change (e.g. a source formula's expression edited but its value not yet recomputed) — bounded out, noted as a residual.

## §6 LOCK-E — values-free

- **E1**: `source_hash` is SERVER-SIDE ONLY — never sent to any client. The client-facing hydration payload carries only the derived boolean `stale` per cell. A full-width `sha256` (not a truncated/small-domain digest) so the stored hash is not itself a value oracle even server-to-server.
- **E2**: the badge is a boolean; it leaks only "this AI output is older than its inputs", never any source value or the AI text.

## §7 Golden matrix (fail-first, real-DB)

| # | Scenario | Locked outcome |
| --- | --- | --- |
| GS1 (headline + anti-footgun) | edit a source field an aiShortcut depends on | the dependent AI cell reads `stale: true`; **ZERO provider call, ZERO new `multitable_ai_usage_ledger` row** written by the source edit (assert ledger count unchanged) |
| GS2 | edit a NON-source field on the same record | the AI cell is NOT stale (hash unchanged) |
| GS3 | explicit re-run of the shortcut | new `source_hash` upserted, `stale` clears; the re-run is a live AI call behind the confirm gate and surfaces the priced estimate first (cross-ref S4 #3673) |
| GS4 (values-free) | inspect the client hydration payload for a stale cell | carries only `stale: boolean`; the `source_hash` never appears client-side |
| GS5 (transitivity via value) | a source that is itself a formula recomputes to a new value (W1-1 path) | dependent aiShortcut goes stale (hash-over-values catches it, no explicit cascade) |
| GS6 (derived-stable) | re-read a stale cell with no further change | `stale` stays stable/deterministic (pure derivation, no drift) |
| GS7 (regression) | a field with NO aiShortcut config, ordinary edits | no generation row, no staleness machinery, byte-identical to pre-S3 |

## §8 Rollout
One narrow migration (§3, gated), a small addition at the two AI write sites (compute+upsert the hash), a read-time derived boolean in hydration, and reuse of the existing run/estimate/confirm-gate for re-run. No new env flag (the confirm gate already governs the only spending path). Lands as one runtime PR after ratification + the §3 storage opt-in.

## §9 Arc placement
- ✅ S1 provenance · ✅ S2 prompt-config-history · ⬜ **S3 staleness lineage — this lock** · ⬜ S4 cost visibility (#3673, PROPOSED) · 🔒 S4b per-run cost (ledger `run_id` migration, split from S4) · 🔒 S5 normalize kind (+classify→select rider) · ✅ W1-1 runtime [#3679, merged 2ea154b32] · 🔒 W1-3 runtime [#3676, pending owner A/B].
