# Multitable Formula-over-Lookup — Design-Lock — 2026-06-03

> Status: **DESIGN-LOCK (docs-only). No code in this PR.** Owner decisions locked 2026-06-03 (§2, §12). Near-term scope = **A-min only**. Implementation is a **separate cut** — must NOT be merged with this design-lock.
> Author: Claude (Opus 4.8, 1M context) + read-only code recon on `origin/main` @ `22985cfab`.
> Worktree: `docs/multitable-formula-over-lookup-design-20260603` off `origin/main`.
> Builds on the characterization note `multitable-formula-lookup-recalc-gap-20260528.md` (#1971): re-anchors
> it against current `main`, deepens the option analysis, and forces the one decision the gap implies.
> K3 / frozen: multitable kernel-polish only — **does not touch `src/formula/engine.ts`**, central RBAC/auth, or `plugin-integration-core`.

---

## 0. TL;DR — the single decision this doc forces

A multitable **formula** field that references a **lookup/rollup** field is broken on two silent, pre-existing
layers (trigger + value-source, §1). Fixing it correctly is **the concrete instance of the "multi-hop derived
field" question that the C1 RFC deliberately deferred** (`formula-parser-and-derived-ref-graph-rfc-b1c1-20260526.md`,
2026-05-27: *"don't build the derived-ref graph until a concrete multi-hop need; single-hop + A2-defense is
self-consistent"*). A formula depending on a lookup depending on a link/foreign-record **is** a 2-hop derived
chain.

So the doc exists to force **one gate**:

> **Is formula-over-lookup a supported product capability?**
> - **Yes → fix it** (Option **A**, targeted, no storage change). The owner framed this task as filling a
>   "真功能缺口" → this is the centered path.
> - **No → reject it honestly** (Option **C**, reject-at-field-write + grandfather existing). Smaller, matches
>   the single-hop RFC posture, but removes a capability.
> - Options **B** (materialize) and **D** (parser + derived-field graph) are heavier, storage-/RFC-adjacent,
>   and **deferred** — they are not the near-term answer.

Within **A**, there is a second gate that decides whether A is a *targeted fix* or *a slice of the deferred
graph* — **A-min vs A-full** (§3.1). These are separate opt-ins.

This is **low-urgency**: the gap is owner-characterized as *defensive, not a live bug* (no current path feeds an
object-valued lookup into eval; the failure is "computes against 0", not a crash). It is *prep/hardening*, not a
firefight.

---

## 1. Current-state ground truth (anchored, `origin/main` @ `22985cfab`)

### 1.1 What already works (do not redesign)

- **Direct source-field edit → formula recalc** is wired + tested (A1, PR #1883; A1.1 made formula fields
  read-only, #1890). Grid PATCH of a field a formula directly references re-runs the formula and materializes
  the value. Tests: `tests/unit/multitable-formula-engine.test.ts`, `tests/unit/record-write-service.test.ts`,
  `tests/e2e/multitable-formula-smoke.spec.ts` (case 4).
- Formula expression source of truth = `field.property.expression`; recalc reads it (`formula-engine.ts:271-289`).
- The dependency edge formula→lookup **is recorded**: `formula_dependencies` insert at `univer-meta.ts:787`.

### 1.2 The gap — two layers (re-anchored)

**Layer 1 — Trigger / propagation (the formula often doesn't re-run).** Two distinct sub-cases:

- **1a — same-record link edit.** Editing a record's *link* field changes its derived *lookup* value. But the
  write path builds `changedFieldIds` from the user's **directly-patched** field ids only
  (`record-write-service.ts:869`), and `recalculateFormulaFields` gates on
  `formula_dependencies WHERE depends_on_field_id = ANY(changedFieldIds)` (`univer-meta.ts:1633-1638`). The
  formula depends on the *lookup* id, which is **not** in `changedFieldIds` (the *link* id is) → the gate
  misses → **the formula does not re-run** though its lookup just changed.
- **1b — foreign-record edit.** `computeDependentLookupRollupRecords` (`record-write-service.ts:848`, def
  `univer-meta.ts:1829`) recomputes lookup/rollup for **related records** and surfaces them in the response +
  realtime (`record-write-service.ts:854-860`, `:891-894`). But those changed *lookup* field ids are **never
  fed** into `recalculateFormulaFields` for the related records → the formula on the affected records does not
  re-run either. The affected formula may sit on a **different record, possibly a different sheet** — which is
  why `recalculateFormulaFields` is explicitly documented "intra-sheet / intra-record only" (`univer-meta.ts:1619`).

**Layer 2 — Value source (when it *does* re-run, it reads `0`).** `recalculateFormulaFields` →
`MultitableFormulaEngine.recalculateRecord` (`formula-engine.ts:249`) **re-loads the record from DB**
(`:256-259 SELECT id, data`) and evaluates against that raw `data`. Lookups/rollups are **computed-on-read, not
materialized**: `applyLookupRollup` (`univer-meta.ts:1655`) writes resolved values **only to the in-memory
`row.data[fieldId]`** (`:~1762/1765/1770/1775`, no `UPDATE`/`INSERT` inside the function), never to
`meta_records.data`. So at recalc time `data[lookupFieldId]` is absent → `evaluateField` substitutes
`undefined → '0'` (`formula-engine.ts:111`) → the formula computes **against 0**.

### 1.3 The reject-guard surface (relevant to Option C)

`validateFormulaReferences` (`univer-meta.ts:990`) runs at field create/update (`:4664`, `:4957`) and rejects
**only** self-reference and formula→formula — **not** formula→lookup. `findFormulaReferrers` (`:~1024`)
already enumerates the live formula fields that reference a given field id (used by the A2-defense reverse
guard) — directly reusable to **find existing formula→lookup fields** for a grandfathering audit.

### 1.4 Dry-run (#5c) is a SEPARATE surface — do not conflate

`POST /sheets/:sheetId/formula/dry-run` (`univer-meta.ts:6210`). With a `recordId`
(`:6249-6290`): `requireRecordReadable` (record-level read gate) → raw `SELECT data` (`:6273`) → **per-reader
D3c mask** `filterRecordDataByFieldIds(rawData, allowedIds)` (`:6285`) → `effectiveSampleValues =
{...maskedData, ...sampleValues}` (`:6287`) → no-DB `dryRunFormulaEngine.dryRun` (`:6290`). Dry-run therefore
also reads **raw** values (lookups absent) and shows the same `0` today — but it is an **ephemeral, per-reader,
non-persisted preview** of an *unsaved* expression. It shares `evaluateField` with recalc but **nothing else**:
no DB write, a per-reader field mask, and a no-DB engine. **This design changes production recalc, not dry-run**
(§6).

---

## 2. The decision (the gate)

**Do we support formula referencing lookup/rollup as a product capability?** Everything below hangs on this one
answer.

**DECIDED 2026-06-03 — YES, via the minimal supportable path: Option A-min.** We defined this as a real semantic
gap, so we fix the smallest same-record / same-sheet path rather than write-reject. Option **C** (reject at
field-write) is **retained only as the fallback** should product later decide *not* to support formula-over-lookup.
**A-full** (foreign-record → related-record propagation) is **a separate gated slice — not promised here** (§3.1).
**Dry-run stays #5c raw/masked — unchanged** (§6).

---

## 3. Options

Lettering matches the request. Cross-reference: A = #1971(a) / borrow-plan Track-A chaining item; B = #1971(b) /
Track **C2b**; C = #1971(d) / "stay single-hop"; D = #1971(c) / Track **B2** parser + Track **C** graph.

### 3.1 Option A — feed the hydrated row into recalc (+ propagate the trigger) — **centered**

Fix both layers without any storage change:
- **Value source:** before evaluating a record's formulas, run `applyLookupRollup` on the loaded row and feed
  that **hydrated in-memory `row.data`** into `evaluateField`, instead of `recalculateRecord` re-loading raw
  data from DB. Requires a defined **lookup-before-formula ordering** within the record.
- **Trigger:** when lookups recompute, add the changed *lookup* field ids into the formula-recalc trigger so the
  gate (`univer-meta.ts:1633`) fires.

**A splits into two separately-gated sizes — this is the load-bearing scope decision:**

| | A-min (targeted fix) | A-full (bounded multi-hop) |
|---|---|---|
| Layer 1 | **1a only** — same-record link edit feeds the changed lookup id into the same record's formula recalc | **1a + 1b** — foreign-record edits also propagate to *related records'* formulas |
| Layer 2 | hydrate the **same record's** row before eval | hydrate **related records'** rows before eval |
| Boundary | stays within `recalculateFormulaFields`'s **"intra-sheet / intra-record only"** contract (`:1619`) | **crosses** it — affected formula is on another record / sheet = **a bounded slice of C2a** multi-hop transitive recompute |
| Risk | Medium — write-path trigger + eval input + ordering, one record | Medium-high — cross-record/sheet propagation, the deferred-graph territory |
| Storage | none | none |

**A-min is a genuine targeted fix. A-full is "you are now building part of the deferred derived-field graph"** —
do not let A-min silently grow into A-full. A-min ships first; A-full is its own opt-in (decided against the C1
RFC's multi-hop posture, not slipped in).

**A-min acceptance MUST prove it fixes *only* the same-record path** (owner requirement, 2026-05/06): the test
matrix must include a **negative** foreign-record assertion — editing a *foreign* record so a related record's
lookup changes must **NOT** be expected to re-run that related record's formula under A-min (it asserts the
formula stays stale and that boundary is documented). This prevents a future foreign-record fix from being
mistaken as already-covered, and prevents A-min from silently claiming A-full's scope. See T1/T2 (positive,
same-record) vs T4a (negative, foreign-record boundary) in §10.

### 3.2 Option B — materialize lookup/rollup values

Persist computed lookup/rollup into `meta_records.data` (or a side table) so recalc-from-DB sees them.
= borrow-plan **Track C2b** ("controlled materialization of derived values + invalidation/recompute"), explicitly
flagged there as **the heaviest, storage-model-adjacent, independent gate**, and architecturally aligned with the
async derived-update outbox (Track D, frozen, DF-N2-bound). **Largest storage + invalidation surface. Deferred.**

### 3.3 Option C — reject formula→lookup at field-write (+ grandfather) — the honest "no"

Extend `validateFormulaReferences` (`univer-meta.ts:990`) to reject a formula whose expression references a
lookup/rollup field, at field create/update (`:4664`, `:4957`). Turns the silent `0` into an explicit authoring
error. **But the guard runs only at field-write**, so **existing** formula→lookup fields persist computing `0` —
this needs a **grandfathering decision**: surface them via an audit (reuse `findFormulaReferrers` to enumerate),
warn rather than auto-break, and decide migrate-or-leave. A validator alone does **not** close the gap.
Smallest, RFC-consistent (stays single-hop), but **removes a capability**.

### 3.4 Option D — AST parser + unified derived-field dependency graph

Replace the regex `{fld}`-macro engine with an AST-based parser whose visitor extracts dependencies, and build a
unified derived-field dependency graph that resolves lookup refs properly (subsumes A2b + this gap). = borrow-plan
**Track B2** (parser, deferred behind B1) + **Track C** (graph; C1 RFC = *do not build until concrete multi-hop
need*). **Largest; a separate RFC; deferred.** Notably, *this gap* (formula-over-lookup) is the candidate
"concrete multi-hop need" that would justify opening Track C — but only as a bounded C2a slice, which A-full
already represents at far lower cost.

---

## 4. Permission boundary (constraint #5)

**Finding (verified, not assumed): a formula result encoding a restricted input is a PRE-EXISTING systemic
property, not a new leak introduced by hydrating lookups.**

- `validateFormulaReferences` has **no per-field read gate** (only self + formula→formula); `recalculateRecord`
  reads raw DB **reader-agnostically** and materializes the value at **write time**. So a formula `={A}` where
  `A` is field-permission-hidden **already** bakes A's value into the formula result, which any reader who can
  see the *formula field* then sees — independent of A's visibility. This is the same shape as the D3 finding
  ("multitable perms are annotation-rich, enforcement-thin"; `permission-matrix-golden-20260525.md`).
- Therefore Option A (hydrating a lookup into the formula result) is **consistent** with this property — it does
  **not** introduce a new leak class. The field-read gate governs **display** of the lookup field and the
  formula field *independently*; computation is reader-agnostic and materialized once.

**What the design still must guarantee (the real content of constraint #5):**
1. **Production recalc** must hydrate the lookup via the **same `applyLookupRollup` resolution** used on the read
   path — it computes the lookup's *actual* value (its definition), it does not invent or bypass anything. No new
   read path, no central RBAC/auth touched. **This slice does NOT change the formula field's visibility model and
   adds NO new field-permission gate** — the formula field and the lookup field keep their existing, independent
   visibility (`deriveFieldPermissions`); the change is purely the recalc *eval input*. The formula-result-encodes-
   its-inputs behavior is the **pre-existing** systemic property above, not introduced or widened here.
2. **Dry-run stays per-reader masked.** #5c already omits field-permission-denied keys from samples
   (`filterRecordDataByFieldIds`, `univer-meta.ts:6285`). A value-source fix for production recalc **must NOT**
   auto-couple dry-run to hydrate **unmasked** lookups — that would feed a denied lookup value into a per-reader
   preview, the one thing constraint #5 names. Dry-run keeps raw-masked samples + manual `sampleValues` override
   (the user's own input); hydrating dry-run's record-sampling is a **separate, later, opt-in** decision (§6).
3. If the owner is uncomfortable with formula-results-encode-restricted-inputs as a *general* property, that is a
   **separate systemic D3 question** (applies to formula→regular-restricted-field too) — it must not be conflated
   with, or block, this gap.

---

## 5. Frozen / K3 boundary (constraint #6)

- **Do not modify `src/formula/engine.ts`** (the shared base engine — attendance-shared, K3-frozen; borrow-plan
  Track F already cleaned its dead graph code). All work is in the **multitable wrapper** `multitable/formula-engine.ts`
  (`recalculateRecord` eval input + ordering) and the **recalc orchestration** (`record-write-service.ts` Step 4c
  trigger, `univer-meta.ts recalculateFormulaFields` + `applyLookupRollup` reuse).
- No central RBAC/auth, no `plugin-integration-core`, no migration / storage-model change (Options A and C are
  storage-neutral; B and D are explicitly deferred precisely because they are not).
- The Yjs collab write path keeps its `recalculateFormulaFields`/`applyLookupRollup` **no-op stubs** (consistent
  with A1); collab-path derived recalc is a separate issue, out of scope.

---

## 6. Dry-run vs production recalc — explicit non-coupling

They share only `evaluateField`. **Different contracts:**

| | Production recalc | Dry-run (#5c) |
|---|---|---|
| Trigger | write path (materializes to DB) | interactive POST, nothing persisted |
| Reader model | reader-agnostic (write-time) | **per-reader masked** (`filterRecordDataByFieldIds`) |
| Engine | default (DB-capable) | **no-DB** `dryRunFormulaEngine` |
| This design | **changes it** (Option A hydrates the lookup) | **unchanged** |

A value-source fix targets **production recalc**. Whether dry-run's `recordId` sampling should *also* hydrate
lookups (to keep "preview == production" — #5c's stated goal) is a **separate, smaller, opt-in** follow-up, and
if taken it must hydrate **only the reader-visible** lookups (never bypass the #5c mask). Default: leave dry-run
as-is; document that its record-sampling reflects raw saved values, lookups appear empty unless supplied via
`sampleValues`.

---

## 7. Recommendation

- **If formula-over-lookup is a supported capability (owner's framing suggests yes): Option A-min**, shipped as a
  standalone slice — targeted, storage-neutral, stays within the intra-record contract, closes the common case
  (same-record link edit → correct formula). **Gate A-full separately** (it is a bounded C2a multi-hop slice;
  decide it against the C1 RFC, do not slip it in).
- **If we decide *not* to support it: Option C** — reject at field-write **plus** a grandfathering audit (reuse
  `findFormulaReferrers`); a validator alone is not enough.
- **B (materialize) and D (parser/graph) are deferred** — heavier, storage-/RFC-adjacent, and B is DF-N2-bound.
- Pick **A-min or C as the near-term move**; do not bundle. Each remaining piece (A-full, B, D) is a separate
  explicit opt-in.

---

## 8. Minimal PR slicing

| Slice | Title | Scope | Risk | Gate |
|---|---|---|---|---|
| **Slice 1 (A-min)** *(if "support it")* | Hydrate same-record lookups + propagate same-record trigger | `multitable/formula-engine.ts` (eval input = hydrated row + lookup-before-formula ordering), `record-write-service.ts`/`univer-meta.ts` (add changed lookup ids from the same-record link edit into the recalc trigger) | Medium | owner opt-in (capability = yes) |
| **Slice 1′ (C)** *(if "don't support it")* — alternative to Slice 1 | Reject formula→lookup at field-write + grandfather audit | `univer-meta.ts validateFormulaReferences` + an audit using `findFormulaReferrers` | Low | owner opt-in (capability = no) |
| **Slice 2 (A-full)** 🔒 | Foreign-record → related-record formula propagation (bounded C2a) | cross-record/sheet propagation in the related-recompute path | Med-high | separate opt-in, decided vs C1 RFC |
| **Slice 3 (B)** 🔒 | Materialize derived values | storage-model-adjacent (Track C2b) | High | independent storage gate / DF-N2 |
| **Slice 4 (D)** 🔒 | AST parser + derived-field graph | engine + dependency-model redesign (Track B2/C) | Highest | separate RFC |

Slice 1 (or 1′) is the only near-term move. 2/3/4 are frozen opt-ins.

---

## 9. TODO checklist (gated)

Markers: ⬜ todo (chosen near-term slice) · 🔒 gated (separate opt-in) · ◻️ decision-pending (owner gate §2)

### Decision gate (§2)
- ✅ **DECIDED 2026-06-03: support = YES → Slice 1 (A-min).** Slice 1′ (C) retained only as the not-support fallback.

### Slice 1 — A-min (CHOSEN)
- ⬜ `recalculateRecord`: evaluate against a row **hydrated** by `applyLookupRollup` (lookup-before-formula ordering), not a raw DB reload.
- ⬜ Trigger 1a: feed the same-record changed **lookup** field id(s) into the recalc gate so `formula_dependencies` matches.
- ⬜ Reuse the **same** `applyLookupRollup` resolution (no new read path; no perm bypass; no visibility-model change; no new field-permission gate).
- ⬜ Keep dry-run untouched (no auto-hydrate); Yjs stubs unchanged.
- ⬜ Tests per §10: positive same-record (T1/T2) + value-source (T2/T3 incl. object-lookup `#VALUE!`) + **negative foreign-record boundary (T4a — required, locks A-min to same-record scope)** + perm-property (T5) + dry-run mask (T6) + A1 regression (T8) + frozen (T9).

### Slice 1′ — C (NOT chosen; fallback only)
- ⬜ Extend `validateFormulaReferences` to reject formula→lookup at field create/update.
- ⬜ Grandfather audit: enumerate existing formula→lookup via `findFormulaReferrers`; warn, don't auto-break; owner decides migrate/leave.
- ⬜ Tests: new formula→lookup rejected; existing one still computes (grandfathered) + surfaced by audit.

### Deferred
- 🔒 Slice 2 (A-full foreign-record propagation) — bounded C2a, decide vs C1 RFC.
- 🔒 Slice 3 (B materialize) — storage gate / DF-N2.
- 🔒 Slice 4 (D parser + graph) — separate RFC.
- 🔒 (optional) dry-run record-sampling hydration (reader-visible lookups only) — separate opt-in (§6).

---

## 10. Verification matrix (to run at implementation time)

Cover **both layers AND the trigger sub-split** — a single "real patch" test would let a half-fix (1a fixed,
1b not) look done (#1971 §5). All real-DB (the V-A2b-3 shape becomes applicable once Layer 2 is fixed).

| # | Class | Scenario | Assert |
|---|---|---|---|
| T1 | Trigger 1a (Slice 1) | Edit a record's **link** field so its lookup changes | the **same record's** formula re-runs and reflects the **new lookup value** (not stale, not `0`) |
| T2 | Value source (Slice 1) | After T1, inspect the materialized formula | equals the formula computed against the **actual lookup value**, not `0` |
| T3 | Value source — object lookup | Formula references an **object/multi-value** lookup | result is `#VALUE!` (A2b), **not** a fake `[object Object]`/join and **not** `0` |
| T4a | Trigger 1b boundary (**Slice 1 / A-min — required**) | Edit a **foreign record** so a related record's lookup changes | the related record's formula **does NOT re-run** under A-min — a **negative** assertion that locks A-min to same-record scope (prevents a foreign-record fix being mistaken as covered, and A-min claiming A-full's scope) |
| T4b | Trigger 1b (Slice 2 / A-full, 🔒) | same as T4a, once A-full ships | the related record's formula **re-runs** with the new lookup value (flips T4a's negative to positive) |
| T5 | Perm property | Formula `={lookup}` where the lookup field is field-perm-hidden from reader R; R can see the formula field | formula result is visible to R (documents the **pre-existing** systemic property §4 — same as formula→restricted-regular-field; **not** a regression introduced here) |
| T6 | Dry-run separation | `POST …/dry-run` with `recordId`, lookup field **denied** to caller | denied lookup is **omitted** from samples (mask intact); production-recalc hydration did **not** leak into the per-reader preview |
| T7 | Reject (Slice 1′ alt) | Create/update a formula referencing a lookup | rejected at field-write; existing formula→lookup still computes (grandfathered) + listed by the audit |
| T8 | Regression | Direct source-field edit (A1 path) + non-lookup formulas | unchanged (A1 tests stay green); no `version` bump on derived recalc |
| T9 | Frozen boundary | n/a (static) | no diff to `src/formula/engine.ts`; no migration; Yjs stubs unchanged |

Both bars: unit tests on the wrapper/orchestration where pure, **plus** real-DB integration through the actual
write + `/view` read path (wire-vs-fixture-drift guard) — added to the `plugin-tests.yml` multitable real-DB
runner list so they actually execute (not silent-skip).

---

## 11. Rollback

Option A (chosen Slice 1) is storage-neutral: it changes recalc's eval **input** (hydrated row) and the
same-record trigger. Revert the commit; no data/schema/contract changes; previously-materialized formula values
(computed against `0`) remain until the next recalc — acceptable (they were the pre-fix state). Option C is a
validator + audit; revert restores the prior accept-and-compute-`0` behavior.

---

## 12. Decisions (locked 2026-06-03)

1. **Support formula-over-lookup → YES, via Option A-min.** We treat it as a real semantic gap, so fix the
   minimal same-record / same-sheet path rather than write-reject. **C is retained only as the fallback** if
   product later decides not to support it.
2. **Lock A-min only; A-full is a separate gated slice — not promised.** A-min = same-record link edit + hydrate
   the same record's eval input. A-full = foreign-record change → related-record formula recalc = bounded C2a
   multi-hop; it must be decided on its own against the C1 RFC, not bundled. A-min acceptance must include the
   **negative foreign-record assertion** (T4a) so the boundary is enforced, not assumed.
3. **Dry-run stays #5c raw/masked — do not chase "preview == production."** Dry-run is a per-reader safe preview;
   production recalc is a system-state write. Never auto-carry an unmasked/hydrated lookup into dry-run. Any
   future dry-run hydration must be reader-visible-lookup only and separately designed.

> Implementation is a **separate cut** and must NOT be merged with this design-lock.
