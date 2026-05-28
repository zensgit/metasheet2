# Characterization / design note — formula-over-lookup recalcs against `'0'`

> Date: 2026-05-28 · Status: **CHARACTERIZATION + DESIGN ONLY — 非实现、未排期** · K3: multitable kernel-polish (allowed when scheduled)
> Surfaced during A2b (#1958) while reconciling V-A2b-3. This documents a **pre-existing** behavior gap so it is a *known, deliberate* limitation rather than a hidden bug. No code change here.

## 0. TL;DR
A multitable **formula** field that references a **lookup / rollup** field is broken on **two** layers, both silent + pre-existing:
1. **Trigger / propagation** — when the lookup's value changes (a **link** edit, or a **foreign-record** edit), the formula **usually doesn't re-run at all**: formula recalc is gated on the user's *directly-changed* field ids, which never include the derived lookup field.
2. **Value source** — even when the formula *does* re-run (user directly edits another field it depends on), recalc reads DB raw data where the lookup is absent → `evaluateField` substitutes `undefined → '0'` → it computes **against `0`**.

So formula-over-lookup is frequently **stale**, and when fresh, **wrong (treats the lookup as 0)**. Not introduced by recent work.

## 1. Current behavior (characterization) — two layers

Formulas may reference lookup/rollup fields — the frontend formula source list excludes only `type === 'formula'` (`apps/web/src/multitable/components/MetaFieldManager.vue` `formulaSourceFields`); the backend A2-defense guard `validateFormulaReferences` (`univer-meta.ts:1022`) rejects only formula→formula, not formula→lookup.

### Layer 1 — trigger / propagation (the formula often doesn't re-run)
- The formula's dependency on the lookup field **is** recorded in `formula_dependencies` (insert `univer-meta.ts:819`).
- But the write path triggers formula recalc with **`changedFieldIds` = the user's directly-patched fields only** (`record-write-service.ts:865`), and `recalculateFormulaFields` gates on `formula_dependencies WHERE depends_on_field_id = ANY(changedFieldIds)` (`univer-meta.ts:1653`).
- A **link** edit puts the *link* field — not the derived *lookup* — into `changedFieldIds`; the formula depends on the *lookup* → the gate doesn't match → **the formula doesn't re-run**, even though the lookup's value just changed.
- **Foreign-record** edits: `computeDependentLookupRollupRecords` (`record-write-service.ts:844`) recomputes lookup/rollup for related records and surfaces them in the response (`:985`), but those changed lookup field ids are **not** fed into `recalculateFormulaFields` as `changedFieldIds` → the formula on the affected records doesn't re-run either.

### Layer 2 — value source (when it *does* re-run, it reads `0`)
- `recalculateFormulaFields` (`univer-meta.ts:1641`) → `MultitableFormulaEngine.recalculateRecord` (`formula-engine.ts:249`) **re-loads the record from the DB** (`:257` `SELECT id, data FROM meta_records`) and evaluates against that raw `data`.
- Lookups/rollups are **computed-on-read, not materialized**: `applyLookupRollup` (`univer-meta.ts:1675`) writes resolved values only to the **in-memory** `row.data[fieldId]` (`:1795`), never to `meta_records.data`.
- So at recalc time `data[lookupFieldId]` is absent → `evaluateField` substitutes `undefined → '0'` (`formula-engine.ts:111`) → the formula computes against `0`.

> A2b (#1958) is orthogonal/defensive: it makes `evaluateField` safe **if** a complex value ever reaches it. Here the lookup value doesn't reach eval at all (absent on reload) — which is also why V-A2b-3 (real-DB `lookup→formula→#VALUE!`) is NOT-APPLICABLE today.

## 2. Why it matters / scope
- **Data-correctness surprise** for users who reference lookups in formulas: the result looks computed but treats the lookup as `0`.
- **Low-urgency, usage-dependent**, and **pre-existing** — documenting it as a deliberate known gap, not scheduling a fix here. Any fix is a separate, explicit opt-in.

## 3. Fix options (design — none chosen)
| Option | Sketch | Cost / risk |
|---|---|---|
| **(a) Propagate + hydrate (two parts)** | **(i) Trigger:** when lookups recompute (same-record link edit **and** foreign-record related-recompute), add those changed lookup field ids into the formula-recalc trigger so the gate (`univer-meta.ts:1653`) actually fires. **(ii) Value source:** feed the hydrated in-memory `row.data` (post-`applyLookupRollup`) into eval instead of `recalculateRecord` reloading from DB. | **No storage change**, but **bigger than a value swap** — touches the write-path trigger on **both** the same-record and foreign/related paths, plus the eval input and eval **ordering** (lookup before formula). Medium-high. |
| **(b) Materialize lookups** | Persist computed lookup/rollup into `meta_records.data` (or a column) so recalc-from-DB sees them. | Heavy — storage-model + invalidation/propagation. Reference: Teable `ComputedUpdate*` outbox (see OSS comparison doc). Largest storage impact. |
| **(c) Track B real parser** | Replace the macro-expansion engine with Teable `packages/formula` (MIT) — redesigns the dependency/eval model and could resolve lookup refs properly; **subsumes A2b + this gap**. | Largest; separate RFC. |
| **(d) Reject formula→lookup at field-write** | Extend A2-defense `validateFormulaReferences` (`univer-meta.ts:1022`, run at field-write `:4498`) to reject formula→lookup refs — making the limitation **explicit** instead of silent. | Smallest, **but the guard runs only at field-write** → **existing** formula→lookup fields persist; needs an **audit / backfill / grandfathering** decision (a validator alone does NOT close the gap). Removes a currently-broken capability. |

## 4. Recommendation (if/when pursued — gated, separate opt-in)
- **(a) hydrated-row→recalc** is the most targeted real fix (no storage change), but only worth it if formula-over-lookup is a real product need; it requires the dependency graph to track formula→lookup and a defined lookup-before-formula ordering.
- **(d) reject formula→lookup** is the smallest honest move if we decide **not** to support it (silent-`0` → explicit rejection).
- Do **not** bundle with anything else; decide as its own opt-in. Until then, this note + the tracker backlog entry are the record.

## 5. How to verify (when implemented)
Cover **both layers**, and split the trigger into its two real classes — a single "real patch" test would let a half-fix (e.g. trigger fixed for same-record but not foreign-record) look done:
- **Trigger A — same-record link edit**: edit a record's link field so its lookup changes → assert the formula on that record **re-runs** and reflects the new lookup value.
- **Trigger B — foreign-record edit**: edit a foreign record so a dependent lookup changes → assert the formula on the **related** record(s) **re-runs** (related-recompute drives formula recalc).
- **Value source (both)**: assert the formula uses the lookup's **actual** value, not `0` (and, per A2b, an object-valued lookup still yields `#VALUE!`, not a fake join).

All real-DB (the V-A2b-3 shape — NOT-APPLICABLE today — becomes applicable once Layer 2 is fixed).

## 6. References
- A2b hardening: PR #1958 (defensive `String(value)`收口); V-A2b-3 reframe → NOT-APPLICABLE.
- Tracker: `multitable-open-items-{development-plan,todo,verification}-20260527.md` (backlog entry).
- Borrow plan: `multitable-derived-field-borrow-plan-20260526.md` (A2-full / Track B).
- OSS comparison (materialization / outbox): `docs/research/multitable-vs-teable-hyperformula-comparison-20260526.md`.
