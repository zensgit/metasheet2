# Multitable 1b Slice A — relation-scoped criteria aggregation: development & verification

> Implements the first record-set/range formula slice from the ratified design-lock
> (`multitable-1b-recordset-range-formula-designlock-20260619.md`). **Relation-scoped only** — explicitly
> NOT whole-sheet `SUMIF` parity (the whole-sheet record-set scan remains a separate gated extension).

## 1. What shipped vs. what is designed-next

| Sub-slice | Status | PR |
|---|---|---|
| **A.1 — `RELSUMIF` (relation-scoped sum-if)** | ✅ shipped + verified | #2978 |
| **A.2 — foreign-write fan-out (FOL reverse-edge)** | ✅ shipped + verified | #2978 |
| **A.3 — `RELCOUNTIF`/`RELAVGIF` + arithmetic composition** | 📐 designed (research complete), next slice | — |
| **Slice B — lookup family (`VLOOKUP`/`INDEX`/`MATCH`-relation)** | 📐 designed (research complete), next slice | — |
| **Slice C — array aggregation / array-return** | 📐 designed (research complete), next slice | — |
| Whole-sheet record-set scan | 🔒 gated extension (out of scope, owner-gated) | — |

A.1 + A.2 are the **leak-closed core** of relation-scoped criteria aggregation with the safety rails locked
once (permission taint / `#PERM!` / `#LIMIT!` / fan-out / caps). The remaining sub-slices reuse this core
nearly verbatim; their designs (§6) are complete and validated against the code, ready to build as the next
gated PRs.

## 2. The function

`RELSUMIF("linkFieldId", "targetFieldId", "criteriaFieldId", "operator", criteriaValue)` — sums a foreign
`targetFieldId` over the records linked to the current row via `linkFieldId`, keeping only the linked records
whose `criteriaFieldId` matches `operator`/`criteriaValue`. The criteria value may be a **current-record
`{fld}` reference** — the genuine capability over rollup-with-filter (whose filters are static literals).

**Naming (re-confirmed per the design-lock's binding gate):** `RELSUMIF` is a deliberately relation-scoped
name. It does NOT promise classic whole-sheet `SUMIF(range, criteria, sum_range)` semantics; the reach is the
link relation, never an arbitrary sheet column.

## 3. Architecture

- **Parser** (`parseRelationAggregationCall`): SOLE-CALL grammar, quote-aware arg split, rejects nested
  parens — avoids the fragile substitute-result-into-expression approach. `RELATION_AGG_FUNCTIONS` maps the
  name → aggregation (extension point for A.3).
- **Wrapper / resolver** (`resolveRelationAggregation`, the design-lock's Block-6 boundary): materializes the
  **permission-filtered** linked-record set for one call — reusing the rollup core (`resolveReadableSheetIds`,
  `resolveForeignFieldReadability`, `shouldMaskForeignField`, `loadDeniedRecordIds`) — then the **pure
  `aggregateRollup`** reduces it. The pure engine never does IO (parity is free).
- **Write recompute hook** (`recalculateFormulaFields`): relation-agg formulas are resolved in the **writer's
  `req`** (materialize-at-write), held out of the pure-engine set; a composed expression fails loud.
- **A.2 fan-out** (`computeDependentLookupRollupRecords`): a foreign target/criteria edit recomputes the
  source RELSUMIF inline (the same-sheet dep-gate can't see a direct-foreign dep), with a write-side
  taint-skip, merged into the echo + unmasked `affectedFieldIds` for realtime invalidation.
- **Read-path taint leak edge** (`resolveTaintedFormulaFieldIds`): parses relation-agg formulas and DROPS the
  field on read for any reader who can't see its foreign target/criteria (or cross-base). This is what makes
  materialize-at-write safe.
- **Dependency registration**: the link field is registered as a same-sheet edge (the `{fld}` extractor misses
  the string-literal link arg); the criteria `{fld}` value is caught normally.
- **Validator**: rejects the composition cliff at save (fail-loud), complementing the recompute `#ERROR!`.

## 4. Permission model (the security core)

**Materialize-at-write + per-reader field-drop at read.** The aggregate is computed once in the writer's
context; on read, a reader who can't see the foreign target/criteria gets the **field dropped** (not the
writer's value). This reconciles the design-lock's Block 2 (per-actor) and Block 7 (materialize): the value
is materialized once, but no shared value leaks.

- **`#PERM!`** — unreadable foreign target/criteria, or a cross-base foreign sheet (out of scope at lock time).
- **`#LIMIT!`** — `MAX_RELATION_SCAN_RECORDS` (count-first; never an unbounded scan).
- **Observable (decided):** a denied reader sees the field **absent** (the shipped formula-over-lookup model),
  not a `#PERM!` cell. This amends Block 2 for relation-aggregation formulas to the field-drop model.
- **Known property of the materialize model (stated, not a bug):** the read mask covers a denied *field*, not
  denied *records* — a row-denied writer persists a partial aggregate a higher-privilege reader sees as
  authoritative (an under-count). Identical to the formula-over-lookup / rollup-materialize behavior; the case
  a **per-read** model (compute in each reader's context, persist nothing) would avoid. Per-read is the clean
  alternative to fan-out/materialize and remains available if preferred.

## 5. Verification

All local checks green; the real-DB goldens run in CI (test 20.x) via `plugin-tests.yml`.

| Check | What it proves | Result |
|---|---|---|
| `multitable-relation-aggregation-parse.test.ts` (11 unit) | grammar; sole-call; composition-cliff detector; quote/paren edge cases | ✅ local |
| `multitable-relation-aggregation.test.ts` → relation sum | sum over linked records matching criteria (= 30) | ✅ real-DB (CI) |
| → **read-leak gate (fail-first)** | a RELSUMIF over a denied foreign field is **absent** for the denied reader (300 for an allowed reader) | ✅ real-DB (CI) |
| → composition cliff | `RELSUMIF(...)+1` → `#ERROR!` (fail-loud) | ✅ real-DB (CI) |
| → **A.2 fan-out** | editing a FOREIGN target record recomputes the source RELSUMIF (30 → 1020) | ✅ real-DB (CI) |
| `multitable-record-lock-guard.guard.test.ts` | both new materialization `UPDATE`s carry a lock disposition | ✅ local (4/4) |
| `multitable-egress-coverage-guard.test.ts` | no new ungated record-data egress | ✅ local |
| `tsc --noEmit` (core-backend) | type-clean | ✅ local (0 errors) |
| full core-backend unit suite | no regression | ✅ local (exit 0) |

The read-leak gate is the keystone: it is RED without the `resolveTaintedFormulaFieldIds` extension (the
denied reader would receive the writer's materialized aggregate) and GREEN with it.

## 6. Designed-next sub-slices (research complete, ready to build)

- **A.3 — `RELCOUNTIF`/`RELAVGIF` + composition.** `RELAVGIF` → `aggregateRollup(values,count,'avg')` (trivial
  map addition). `RELCOUNTIF` counts matched records — needs a count-only signature (no target field), so the
  parser gains a per-function arity. **Composition** (`RELSUMIF(...)+1`) is the harder part: it requires the
  pure engine to receive the pre-resolved aggregate via the function-context (not string substitution), the
  one piece beyond the sole-call cut.
- **Slice B — lookup family.** Fork `resolveRelationLookup` from `resolveRelationAggregation` (~90% reuse):
  single-row first-match resolution instead of reduce; not-found → `#N/A` (denied row → not-found, denied
  field → `#PERM!`). Reuses the parser, the recompute hook, and the taint extension **verbatim** (target =
  returnField, criteria = matchField). Same FOL reverse-edge fan-out (bounded to one row).
- **Slice C — array aggregation / array-return.** Return the materialized `values[]` array instead of
  reducing it (the pure engine's return type already supports arrays; no engine overhaul). Reuses A.1's
  materialization + permission/taint path; stored as a native JSON array in `record.data`. ~50–150 lines.

Each is its own gated PR with its own fail-first real-DB goldens (reusing this slice's leak-gate pattern).

## 7. Files

- `packages/core-backend/src/routes/univer-meta.ts` — parser, resolver, recompute hook, A.2 fan-out, taint
  extension, dep registration, validator, sentinels, caps.
- `packages/core-backend/tests/unit/multitable-relation-aggregation-parse.test.ts` — pure grammar tests.
- `packages/core-backend/tests/integration/multitable-relation-aggregation.test.ts` — real-DB goldens.
- `.github/workflows/plugin-tests.yml` — golden registration.
- `docs/development/multitable-1b-recordset-range-formula-designlock-20260619.md` — design-lock amendment
  (Block-2/7 reconciliation, observable, known property, sub-slice checklist).
</content>
