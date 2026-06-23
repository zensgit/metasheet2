# Restore Batch / Scope Identity — DESIGN-LOCK

> Status: **DESIGN-LOCK, docs-only. Runtime GATED behind ratification of §6 (D1–D6) + an explicit owner opt-in.**
> This is the next feature on the restore line after per-field (slice 2): extend the restore identity from a
> SINGLE record-version to a MULTI-record scope. It is the one piece that genuinely changes the T6-1 identity
> claims (per-field deliberately did not — a field subset is a filter folded into the `changesHash`; multiple
> records are a new scope). The design-lock is the completion artifact; **no runtime is built until ratified.**
> Basis: the T6 scoped-restore design-lock (SR-1..SR-6) + the per-field slice (filter-then-hash). This references
> those, does not re-derive them.

## 1. Problem + why this is a NEW scope (not another filter)

Per-field restore binds a field subset of ONE record-version inside the existing `changesHash` — no new claim,
because the diff hash already enumerates which fields change and to what. A BATCH restore (restore N records to a
point, or undo a whole history batch across the records it touched) is different: the identity must bind WHICH
records, not just which fields. That requires a new `scope` claim + a scope canonical hash. The T6-1 [P2]
scope-lock named exactly this boundary ("multi-record / batch still needs a scope claim").

## 2. The identity extension (BS-* extend SR-*)

- **BS-1 — the `scope` claim + scope canonical hash (the new binding).** The identity gains
  `scope: { kind, recordIds?, batchId? }` and a `scopeHash` that binds, deterministically and order-invariantly:
  (a) the canonical record set (sorted record ids, deduped — the same Set discipline per-field used for fields),
  and (b) each record's per-record `changesHash` (the masked, field-filtered diff for that record). So the
  identity binds the EXACT set of records AND each record's exact diff. A different record set, an added/removed
  record, or a changed per-record diff → a different `scopeHash` → reject. (Extends SR-3 + per-field's
  filter-then-hash to the record axis.)
- **BS-2 — per-record fan-out gates, re-applied at execute for EVERY record (the real SR-2 surface).** For each
  record in scope the execute re-applies, fresh: row-level read-deny (`loadDeniedRecordIds`), the per-field write
  gate (`FieldMutationGuard` + `field_permissions`), and `expectedVersion`. This is the surface the per-record
  restore never had to fan out over — a denied/forbidden record must never be written, and its existence must not
  leak via counts (LOCK-3 / PV-4: `visibleAffected*`, the reset-style count is leak-prone).
- **BS-3 — all-or-nothing vs partial-skip, explicitly (D2).** Two modes: PARTIAL (each record restores or is
  skipped+reported independently — a denied/conflicted record drops out with a per-record reason, the rest
  proceed) and ALL-OR-NOTHING (any single denied/conflicted/forbidden record blocks the ENTIRE batch — one
  transaction, no partial write). The success response reports per-record outcomes (restored / skipped+reason /
  conflict).
- **BS-4 — forward-only, append-only (SR-1).** Every record's restore is a forward revision (set/unset/undelete);
  the batch NEVER deletes a record. Sheet-wide destructive reset (delete post-T-created records) is T8, not this.
- **BS-5 — reveal never composes (SR-4).** A field-audit reveal can never widen what a batch restore writes.
- **BS-6 — bounded + atomic (SR-6).** A hard max scope size; above a threshold the batch runs async (job +
  progress), never a giant synchronous transaction; above the ceiling it is refused (fail-closed), not truncated.
  Idempotency: the per-record `expectedVersion` CAS gives at-most-once (a replay re-hashes the now-restored
  records → diff diverges / version moved → reject), as in per-field — no dedupe table.
- **BS-7 — no scope narrowing/widening replay.** A batch identity minted for `{A,B,C}` cannot execute `{A,B}` or
  `{A,B,C,D}`: the `scopeHash` binds the exact record set, recomputed at execute (the same filter-then-hash
  discipline that made per-field's full-identity-can't-execute-a-subset golden pass).

## 3. Preview ↔ execute (extends the per-field chain)

`restore-preview` accepts a scope (record ids / batch id), computes each record's masked+filtered diff, mints an
identity binding the `scopeHash` (null when any record drifts or the whole scope nets zero changes — no executable
identity, never a `hash([])` token, exactly as per-field). `restore-execute` recomputes per-record diffs → the
scope hash → verifies BEFORE any write (the slice-2 [P2] discipline: a success always consumes a valid identity).

## 4. What it reuses (no re-derivation)

`computeRecordRestoreDiff` (per record), the per-field mask+filter chain, `loadDeniedRecordIds` (per record),
`FieldMutationGuard` + `expectedVersion` (via `patchRecords`), `hashPreviewChanges` (per record) + a new
`hashScope` over the sorted record set + per-record hashes, and the restore-preview-identity contract (extended
with the `scope`/`scopeHash` claims).

## 5. Test plan (when built)

Real-DB: a 3-record batch restores all three (forward revisions); **scope keystone** — an identity for `{A,B,C}`
cannot execute `{A,B}` or `{A,B,C,D}` (mutation-proven); a row-denied record in scope is skipped (PARTIAL) or
blocks all (ALL-OR-NOTHING) and is never written (mutation-checked); a field-forbidden record likewise; counts
never leak a denied record (BS-2); empty/zero-change scope → no executable identity; replay → reject (version
moved); over-ceiling → fail-closed; reveal-doesn't-compose. Plus the end-to-end preview→execute scope golden.

## 6. Decisions to ratify (before any build)

- **D1 — scope kind for v1.** Explicit `recordIds[]` only, vs also `batchId` (restore a whole history batch).
  Recommend: **`recordIds[]` first** (the general primitive); `batchId` resolves to a record set as a follow-up.
- **D2 — default mode.** PARTIAL (skip+report) vs ALL-OR-NOTHING. Recommend: **PARTIAL default, all-or-nothing
  opt-in** (matches per-record restore's surgical behavior; all-or-nothing for transactional callers).
- **D3 — max scope size + async threshold + hard ceiling.** Recommend: sync under a few dozen records, async
  above, hard-refuse above a configured ceiling (mirrors T8's bounded discipline).
- **D4 — `scopeHash` canonicalization.** Recommend: `sha256(JSON.stringify(sortedRecordIds.map([id, perRecordHash])))`
  — order-invariant over the record set, binds each record's diff. (Pin with an order-invariance golden, like
  per-field's link-set.)
- **D5 — who may execute a batch.** The restore capability (`canEditRecord`) for small batches; a higher bar for
  large/async batches (a dedicated capability, like T8's). Recommend: `canEditRecord` + audit; revisit at the
  async threshold.
- **D6 — identity claim shape.** Add `scope` + `scopeHash` to `RestorePreviewIdentityClaims`, keeping
  single-record (`recordId` + `changesHash`) as the no-scope path. Recommend: a discriminated union (single vs
  scoped) so a single-record token can NEVER satisfy a scoped execute and vice versa.

## 7. Gated TODO

- ⬜ **BS-0 — ratify** this doc (D1–D6) + explicit owner opt-in (this changes the T6-1 identity claims — the
  thing that has needed ratification all along).
- 🔒 **BS-1 — identity contract**: extend `RestorePreviewIdentityClaims` with the discriminated `scope`/`scopeHash`
  + `hashScope`; unit goldens (scope keystone, order-invariance, single-vs-scoped disjointness). Contract-only.
- 🔒 **BS-2 — preview**: scope input → per-record diffs → `scopeHash` → mint (null on drift/empty). Read-only.
- 🔒 **BS-3 — execute** (the write): recompute → verify → per-record fan-out gates → forward revisions →
  PARTIAL/all-or-nothing → bounded/async. Real-DB goldens + mutation checks. **The dangerous slice — reviewed alone.**
- 🔒 **BS-4 — FE** batch restore panel (select scope → preview → confirm with per-record outcomes → execute).

## 8. Out of scope / anti-goals

Sheet-wide destructive reset / delete-post-T (that is **T8**, its own ratification); config/schema batch (**T9**);
any write before the scope identity contract + a verified preview exist; composing a reveal into a batch; a
synchronous unbounded batch. **Tripwire:** adding the `scope` claim to the live identity or writing a fan-out
forward revision is BS-1/BS-3 build territory — gated on BS-0, not part of this design-lock.
