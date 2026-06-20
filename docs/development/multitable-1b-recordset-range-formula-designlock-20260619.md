# Multitable 1b — record-set / range formula semantics (design-lock)

> **Status: DESIGN-LOCK ONLY.** This document locks the model for record-set / range formulas
> (criteria aggregation, lookup, array). **No `SUMIF` / `VLOOKUP` is implemented here** — code-first on a
> structure this large goes crooked. Each implementation slice is a separate, explicitly opted-in PR after
> this lock is reviewed.
>
> **Sequence note:** per the standing goal, the next *build* after this lock is **2a filter-by-link /
> lookup-value**, NOT 1b Slice A. Slice A is its own opt-in once the keystone below is decided.

## 0. Why a lock first

1a shipped pure **scalar** formula functions: each `{fld}` is a current-record scalar and the engine is
IO-free, deterministic, parity-testable. Record-set / range formulas break three of those properties at
once — they read *other* records (permissions), they fan out on *foreign* writes (recompute), and they can
scan unboundedly (performance). Those three interact, so they must be decided together before any function
lands.

## 1. KEYSTONE (open question for review) — what can a range reference *reach*?

Everything in blocks 3 / 5 / 7 depends on this, and it is **not yet pinned**. Two options:

| | **Relation-scoped** (locked default, first) | **Whole-sheet record-set** (gated extension) |
|---|---|---|
| Reach | records linked to the current row via a link field | any record in a target sheet matching criteria |
| Example | "sum `amount` of my linked line-items" | "sum `amount` across the sheet where `status = paid`" |
| Fan-out | the existing FOL reverse-edge (bounded by relation cardinality) | any write in the target sheet → invalidate dependents (bounded only by the perf caps in §5) |
| Machinery | **already shipped** (FOL-1 `computeDependentLookupRollupRecords`) | **new** (sheet-level dependency + scan skeleton) |
| Risk | low | high (this is the "permission-filtered record-set 扫描骨架") |

**Locked decision:** the first implementation is **relation-scoped**, reusing FOL. **Whole-sheet
record-set is a gated extension** behind its own opt-in + the §5 caps.

**⚠️ Surfaced for the reviewer:** classic `SUMIF(range, criteria, sum_range)` semantics are *whole-sheet*
(criteria scan over a column), so **Slice A's first sub-decision is its reach.** If Slice A must be true
whole-sheet `SUMIF`, the whole-sheet skeleton is in-scope for Slice A and §3/§5/§7 take the heavier branch.
If a relation-scoped `SUMIF` (criteria over linked records) is acceptable first, Slice A reuses FOL and
whole-sheet is deferred. **Decide this at review before Slice A is opted into.**

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
- 🔒 **G1 — keystone decision** (relation-scoped vs whole-sheet for Slice A) — *owner decision at review of this doc.*
- 🔒 **Slice A — criteria aggregation** (`SUMIF`/`COUNTIFS`/`AVERAGEIF`): contracts → wrapper materialization (permission-filtered, §2) → pure-engine aggregation (§6) → fan-out registration (§3) → caps (§5) → real-DB goldens (§8). *Opt-in after G1.*
- 🔒 **Slice B — lookup family** (`VLOOKUP`/`INDEX`/`MATCH`): single-row resolution + not-found sentinel. *Opt-in after Slice A.*
- 🔒 **Slice C — array** (array aggregation / array-return). *Opt-in after Slice B.*
- 🔒 **Whole-sheet record-set extension** (if not chosen at G1): sheet-level dependency edge + scan skeleton + §5 caps. *Separate opt-in.*

## 4. Non-goals (explicit)
- No new `{fld}` syntax or context-sensitive `{fld}`.
- No background/async recompute queues — fan-out is synchronous-bounded (§5) within the existing post-commit path.
- No cross-base ranges (single-base only at lock time).
- This doc states MetaSheet's own principles; external-product benchmarking stays in research notes.
