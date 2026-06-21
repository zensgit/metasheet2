# Multitable 1b — record-set / range formula semantics (design-lock)

> **Status: DESIGN-LOCK ONLY.** This document locks the model for record-set / range formulas
> (criteria aggregation, lookup, array). **No `SUMIF` / `VLOOKUP` is implemented here** — code-first on a
> structure this large goes crooked. Each implementation slice is a separate, explicitly opted-in PR after
> this lock is reviewed.
>
> **Sequence note:** per the standing goal, the next *build* after this lock is **2a filter-by-link /
> lookup-value**, NOT 1b Slice A. The keystone below is now **decided (relation-scoped, §1)**; Slice A is
> still its own opt-in, taken only after filter-by-link is reviewable.

## 0. Why a lock first

1a shipped pure **scalar** formula functions: each `{fld}` is a current-record scalar and the engine is
IO-free, deterministic, parity-testable. Record-set / range formulas break three of those properties at
once — they read *other* records (permissions), they fan out on *foreign* writes (recompute), and they can
scan unboundedly (performance). Those three interact, so they must be decided together before any function
lands.

## 1. KEYSTONE (decided at review 2026-06-20) — what can a range reference *reach*?

Everything in blocks 3 / 5 / 7 depends on this. It is now **pinned** (resolution below the table). Two options:

| | **Relation-scoped** (locked default, first) | **Whole-sheet record-set** (gated extension) |
|---|---|---|
| Reach | records linked to the current row via a link field | any record in a target sheet matching criteria |
| Example | "sum `amount` of my linked line-items" | "sum `amount` across the sheet where `status = paid`" |
| Fan-out | the existing FOL reverse-edge (bounded by relation cardinality) | any write in the target sheet → invalidate dependents (bounded only by the perf caps in §5) |
| Machinery | **already shipped** (FOL-1 `computeDependentLookupRollupRecords`) | **new** (sheet-level dependency + scan skeleton) |
| Risk | low | high (this is the "permission-filtered record-set 扫描骨架") |

**Locked decision:** the first implementation is **relation-scoped**, reusing FOL. **Whole-sheet
record-set is a gated extension** behind its own opt-in + the §5 caps.

**✅ Resolved (2026-06-20):** Slice A is **relation-scoped** — its criteria/sum range is the set of records
linked to the current row, reusing FOL; it does **not** scan a whole sheet. **This is explicitly *not*
classic whole-sheet `SUMIF(range, criteria, sum_range)` parity** (classic `SUMIF` scans a column across the
whole sheet). Relation-scoped `SUMIF`/`COUNTIFS`/`AVERAGEIF` ship first; the **whole-sheet record-set scan
skeleton is a separate gated extension** (its own opt-in + §5 caps), tracked in §3's checklist. Slice A must
state this scope difference in its own surface (function help / release note) so users are not surprised the
first cut aggregates linked records, not an arbitrary sheet column.

**🔒 Naming gate (binding on the Slice A impl PR):** relation-scoped Slice A does **not** promise classic
`SUMIF` parity. If the implementation exposes the names `SUMIF` / `COUNTIFS` / `AVERAGEIF` to users, the
Slice A PR MUST re-confirm semantics/naming at that point and make the relation-scoped (NOT whole-sheet)
reach explicit in the user-facing surface (function help / error text / release note). Reusing the
well-known spreadsheet names **without** that disclaimer is not permitted — a user must never be led to
believe whole-sheet range scan is already supported. (If a clean relation-scoped name is preferable to an
`*IF` name carrying whole-sheet baggage, that naming decision is made in the Slice A PR, not assumed here.)

## 2. The eight locked blocks

### Block 1 — Reference model
- **Principle:** `{fld}` stays a **current-record scalar**, unchanged and back-compatible. A bare `{fld}`
  MUST NOT silently become a whole-column / cross-record reference — that would break both compatibility
  and permission reasoning.
- **Mechanism:** cross-record reach is **only** reachable through an **explicit function entry** whose
  arguments name the relation (relation-scoped) or the target sheet + criteria (whole-sheet). Range-ness is
  a property of the *function*, never of `{fld}`.
- **Rejected:** context-sensitive `{fld}` (scalar in a cell, whole-column inside an aggregation) — ambiguous
  permissions, silent compatibility breakage.

### Block 2 — Permission taint
- **Principle:** **filter at materialization, never read-raw-then-mask-result.** Denied records and denied
  fields never enter the range. Precedent in this codebase: dashboard `loadChartRecords` (row-deny +
  field-mask *before* the data reaches compute) and the nested-filter redaction guard.
- **Reuse (do not reinvent):** `listUserPermissions` + `isAdmin`, row-level deny (`loadRowLevelReadDenyEnabled`
  / `loadDeniedRecordIds`, admin-bypass), field mask (`deriveFieldPermissions` / `allowedFieldIds`).
- **Partial-permission semantics (locked, per-function):** when a function's result would depend on records
  or fields the requester cannot see, return a **controlled error sentinel** (`#PERM!`), **never a silent
  `null` or a wrong partial aggregate.** A partially-denied `SUMIF` returns `#PERM!`, not the sum of the
  visible subset — a silent partial sum is itself an information leak (the result encodes the hidden rows).
  Lookup-family (Slice B) may instead return "not found" when the *target row* is denied, since that does
  not leak an aggregate — the exact sentinel is decided per function in its slice, but the rule "denied →
  sentinel, never silent null" is universal.

### Block 3 — Recompute fan-out
- **Principle:** a **reverse-edge dependency index**; a foreign-record change recomputes **only** affected
  formulas, never a full-table scan.
- **Mechanism (relation-scoped):** extend the shipped FOL reverse-projection
  (`record-write-service.ts` fan-out → `computeDependentLookupRollupRecords`) — a range formula registers
  the same kind of dependency a rollup does: (source link field, target field, criteria fields).
- **Mechanism (whole-sheet, gated):** a coarser **sheet-level** dependency edge — "any record write in the
  criteria sheet invalidates dependents of that sheet" — bounded by §5. This is the new machinery the
  keystone gates.
- **Registration (locked surface):** dependency records carry { dependentSheet, dependentField,
  sourceSheet, edgeKind: relation | sheet, criteriaFieldIds }. Cycle detection reuses the dep-graph
  discipline from `attendance-formula-dependency-graph`.
- **Rejected:** recompute-on-every-write / full rescan.

### Block 4 — Function layering
Independent slices, each with its **own real-DB goldens**; do not build them together:
- **Slice A — criteria aggregation:** `SUMIF`, `COUNTIFS`, `AVERAGEIF`. Builds the permission-filtered
  record-set scan skeleton. **First slice** (reach per the keystone).
- **Slice B — lookup family:** `VLOOKUP`, `INDEX`, `MATCH`. Single-row resolution; different sentinel
  (not-found) + different fan-out (single target row).
- **Slice C — array aggregation / array-return.** Array materialization + array-shaped results; depends on
  A's record-set layer.

### Block 5 — Performance bounds (all hard-coded, all fail-loud)
Locked caps (initial values; tune with evidence, but the *shape* is fixed):
- `MAX_RANGE_SCAN_RECORDS` — max records a single formula may scan.
- `MAX_RECOMPUTE_FAN_OUT` — max dependent formulas recomputed per write.
- `MAX_JOIN_DEPTH` — max relation hops a range may traverse.
- `MAX_ARRAY_RETURN` — max elements an array-returning function may produce.
- **Over-limit behavior:** return a formula **error sentinel** (`#LIMIT!`) + emit a diagnostic record;
  **never** run unbounded in the background. Limits are checked *before* materialization where possible
  (count first, then scan) so an over-limit query is rejected, not half-run.

### Block 6 — DB-backed vs pure evaluator boundary
- **Principle:** the existing **pure engine stays IO-free** — it evaluates expressions + scalar functions
  over already-materialized values (it is the engine just extended with EDATE/SECOND/DAYS). A **new wrapper
  layer** owns record-set **materialization** + the **permission-aware range**; it hands the pure engine a
  plain array and the pure engine aggregates it.
- **Parity test (locked):** for every aggregation, the pure engine fed the same array (no DB, no wrapper)
  produces an **identical** result — proving the range layer added IO/permissions without drifting the math.
- **Rejected:** teaching the pure engine to read records (couples it to DB + permissions, kills parity).

### Block 7 — Storage / cache strategy
- **Materialization (locked):** a range result is **computed + persisted to `record.data`** through the
  **same write path as lookup/rollup** (FOL precedent), so realtime, Yjs, and export all read **one**
  consistent value rather than each recomputing.
- **Cache invalidation (locked):** driven by the Block 3 reverse-edge fan-out via the existing
  `createYjsInvalidationPostCommitHook` + `setRealtimeCacheInvalidator` — i.e., the *same* invalidation
  channel FOL already uses. Triggering write paths: record create/update/delete in a dependency sheet, and
  schema changes (field delete / type change) touching a referenced field.
- **Rejected:** per-consumer recompute (realtime / Yjs / export computing independently) → divergence.

### Block 8 — Test matrix (every slice carries the applicable rows; aggregation carries all)
Real-DB goldens: permission golden · masked field excluded from range · row-deny excluded · deleted record
excluded · dependency recompute on foreign write · large fan-out hits the cap → `#LIMIT!` · cycle detection
→ controlled error · cross-sheet access denied → `#PERM!` · feature-flag OFF ⇒ function inert (parses,
returns inert sentinel, no scan) · **pure-engine parity** (same array, no DB, identical result).

## 3. Gated TODO checklist

> 🔒 = locked/blocked on a prior gate · ⬜ = ready when its gate opens · ✅ = done

- ✅ **G0 — this design-lock** (8 blocks + keystone framed).
- ✅ **G1 — keystone decided** 2026-06-20: **relation-scoped** for Slice A (not whole-sheet `SUMIF` parity, §1).
- 🔧 **Slice A.1 — relation-scoped `RELSUMIF` (this PR):** SOLE-CALL `RELSUMIF("link","target","criteria","op","value")` — a relation-scoped name, **not** whole-sheet `SUMIF` (naming gate re-confirmed). Block-6 wrapper materializes the permission-filtered linked set → pure `aggregateRollup`; the criteria value may be a current-record `{fld}` (the delta over rollup-with-filter). Rails locked: `#PERM!` (unreadable target/criteria, or cross-base) · `#LIMIT!` (`MAX_RELATION_SCAN_RECORDS`, count-first) · **read-path taint leak edge** (`resolveTaintedFormulaFieldIds` drops the field for a reader who can't see the foreign target/criteria) · composition cliff → fail-loud `#ERROR!`. Real-DB goldens incl. the fail-first read-leak gate.
  - **Block-2 / Block-7 reconciliation:** the value is **materialized at write** (writer's req; the existing tainted-skip leaves an unreadable writer's prior value untouched) AND **masked per-reader at read** (the field is *dropped* for a reader who can't see its foreign dep). Together these deliver Block-2's per-actor correctness *without* one shared value leaking — Block 7's "materialize" is safe only paired with this read mask. **Observable (decided):** a denied reader sees the field **absent** (FOL-consistent), not a `#PERM!` cell; `#PERM!` is the write-context fail-closed sentinel. This **amends Block 2** ("denied → `#PERM!`, never silent null") for *relation-aggregation formulas*: the read side is a field-drop, matching the shipped FOL model.
  - **Known property of the materialize model (stated, not a bug):** the read mask covers a denied *field*, but NOT denied *records* — a low-privilege writer who is row-denied some linked foreign records persists a **partial** aggregate (their visible subset), which a higher-privilege reader then sees as authoritative (an under-count). This is **identical to FOL's / rollup-materialize behavior** (consistent by design), and is precisely the case **per-read** (compute in each reader's own context, persist nothing) would avoid — the trade-off behind the fan-out/reverse-edge choice. Recorded so the choice is explicit.
- ⬜ **Slice A.2 — foreign-write fan-out (A-full):** recompute a relation-aggregation formula when its FOREIGN target/criteria record changes (extends `computeDependentLookupRollupRecords` for direct-foreign formula deps). **Deferred — staleness-not-leak** (the leak is closed by A.1's read mask), mirroring FOL's own A-min→A-full phasing. *Next opt-in.*
- 🔒 **Slice A.3 — `RELCOUNTIF` / `RELAVGIF` + composition** (a relation aggregation composed inside a larger expression). *After A.2.*
- 🔒 **Slice B — lookup family** (`VLOOKUP`/`INDEX`/`MATCH`): single-row resolution + not-found sentinel. *Opt-in after Slice A.*
- 🔒 **Slice C — array** (array aggregation / array-return). *Opt-in after Slice B.*
- 🔒 **Whole-sheet record-set extension** (the gated branch not chosen at G1): sheet-level dependency edge + scan skeleton + §5 caps. *Separate opt-in.*

## 4. Non-goals (explicit)
- No new `{fld}` syntax or context-sensitive `{fld}`.
- No background/async recompute queues — fan-out is synchronous-bounded (§5) within the existing post-commit path.
- No cross-base ranges (single-base only at lock time).
- This doc states MetaSheet's own principles; external-product benchmarking stays in research notes.
