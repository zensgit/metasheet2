# Multitable Global History / Time Machine — Program Roadmap (T5–T9)

> The 规划 for "complete the remaining history-records + Time Machine development plan." It records the staged
> execution, the build-vs-design-lock split, and the ratification gates. The read-only foundation is built; the
> write/destructive slices are design-locked (the 设计 deliverable) and held for explicit owner ratification.

## 0. Where the line already is (shipped)

T0–T4 + T2a/T2b are COMPLETE on `main`: the read-only history center (timeline, batch detail, filters, search,
cursor) with the LOCK-3 field+row permission layer, the field-audit break-glass arc (A1–A3), and the search
hardening. See `…-mvp-dev-verification…`, `…-t2b-filters-dev-verification…`, and the field-audit arc MD.

## 1. The principle that splits this program

Restore has a **safe half** (everything a restore needs to SHOW / reconstruct — read-only) and a **dangerous
half** (everything it needs to WRITE / delete). The /goal asked for 规划 + 完成 + **设计及验证MD**: so the
read-only half is BUILT (with verification MD), and the write half is delivered as **design-locks** (the 设计
MD that the goal explicitly asked for) + held for ratification. Design-locking the writes is delivering the
requested artifact, not gating.

## 2. Built now (read-only, verification MD)

- **T5-1 — as-of-time-T reconstructor** (`record-reconstructor.ts`): `reconstructRecordsAtT` — the pure-read
  primitive (LOCK-9 delete-aware + LOCK-11 deterministic). The shared root; pinned FIRST with 7 real-DB goldens
  incl. the delete-at-T pin. **BUILT.**
- **T5-2 — restore-preview endpoint** (record-version restore-preview): the T5 design-lock #2985 (PV-1..PV-7).
  Computes what restoring a record to `targetVersion` WOULD change, masked to the actor's fields, writes nothing.
  Reconstructor-based as-of-T preview (over T5-1) deferred as a follow-up — matches §4 D2 (record-version first).
- **T7 — point-in-time read-only view**: the reconstructor projected over a sheet with LOCK-3 masking + pagination
  ("open the table as of T, read-only"). Builds on the pinned T5-1; de-risks T8.

T7 builds on T5-1's exact as-of-T contract; T5-2 v1 is record-version-based (the as-of-T reconstructor preview is the deferred follow-up). **Parallelize the leaves (T5-2, T7), never the shared root.**

## 3. Design-locked now (write / destructive — the 设计 deliverable, NOT built)

- **T6 — scoped restore** (`…-t6-scoped-restore-design-lock…`): the first WRITE — forward revisions over a
  selected scope. Key lock SR-2: batch fan-out is a NEW permission surface (Layer-1's write path never checked
  row-deny; T6 must re-apply every gate per-record). Gated on D1–D4 + opt-in.
- **T8 — point-in-time restore** (`…-t8-pit-restore-design-lock…`): the destructive sheet rollback. Revert-to-T
  (non-destructive, recommend ship first) vs Reset-to-T (destructive, SEPARATE owner ratification). The single
  most dangerous slice; hard-gated.
- **T9 — config history** (`…-t9-config-history-design-lock…`): a SEPARATE program (schema/view/permission change
  history), read-only first, config restore deferred to its own design. No mixed config+data restore.

## 4. Ratification gates (yours)

- **T5 D1/D2/D5** — for the read-only preview (T5-2). Proceeding on the recommended defaults (D1 token→defer T6,
  D2 record-version+batch first, D5 gate on restore-capability) under the planning authority of 请规划; **veto
  any one and I adjust.**
- **T6-0 / T8-0 / T9-0** — each write/config slice needs its own explicit opt-in before runtime; **T8 (destructive
  Reset) needs a separate rollback-semantics sign-off** beyond doc approval.

## 5. Execution order (dependency-correct)

1. ✅ T5-1 reconstructor (root, pinned).
2. ▶ T5-2 preview (record-version) + T7 PIT-view (off the pinned T5-1) — parallel leaves.
3. ✅ T6 / T8 / T9 design-locks (this docs set — the 设计 deliverable).
4. ⏸ T6/T8/T9 runtime — each gated on its ratification; **not started**.

The first release surface stays read-only (reconstruct + preview + as-of-T view); no write/rollback opens until
ratified. This honors "全部完成" — everything is either built (read-only) or designed (writes) — without
self-authorizing a destructive restore.
