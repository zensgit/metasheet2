# Multitable 2a — filter by link / lookup value (design-lock)

> **Status: DESIGN-LOCK ONLY.** No implementation here. Filter-by-link is permission-sensitive and
> cross-cutting (it touches the same ~10 filter eval/prune sites the nested-groups work just refactored),
> so — like the 1b record-set lock — the model is pinned before code. Implementation is a separate opt-in
> after the open questions below are decided at review.

## 0. The problem

Today a `link` field falls through `evaluateMetaFilterCondition` to the **string** branch, where
`toComparableString(cellValue)` runs against `record.data[linkFieldId]` — which is an **array of linked
record IDs**, not the **display value** the user sees. So "filter where Project is *Acme*" actually
compares against opaque IDs and never matches what the user typed. Filter-by-link/lookup means: compare
against the linked records' **display values**, **permission-aware** (a linked record the requester cannot
see must never match and must never leak its display string).

`lookup` fields have the parallel problem: the surfaced value is a looked-up foreign field, materialized
separately; filtering must compare against that materialized value with the same permission discipline.

## 1. The architectural crux (why this needs a lock)

`evaluateMetaFilterCondition(type, cellValue, condition)` is a **pure** function — it sees only the cell's
raw value, not the linked records' display strings. Those come from `LinkedRecordSummary { id, display }`,
materialized per-record (the records-list path already loads them via `applyLookupRollup` /
`loadLinkValuesByRecord`) and permission-filtered against `loadDeniedRecordIds(foreignSheetId)`.

So filter-by-link requires **threading the permission-filtered display values to the eval** — the same
"materialize-then-filter, never read-raw-then-mask" discipline used by dashboard `loadChartRecords` and the
nested-filter redaction. That threading is the design decision; getting it wrong leaks a hidden linked
record's display string into a match result.

## 2. Open questions (decide at review — these gate implementation)

- **Q1 — compare against what?** The linked record's **`display` string** (what the grid shows) vs its
  **primary-field raw value**. Display is what users expect to type; primary-field value is more stable but
  may differ from the rendered chip. *Lean: `display`, since it matches the visible chip and the existing
  summary materialization — but confirm.*
- **Q2 — denied linked record semantics.** When a row links to a record the requester cannot see: is that
  link **excluded from the comparison set** (the row simply doesn't match on that hidden link — consistent
  with row-deny filtering elsewhere), or does the whole condition return a **`#PERM!`-style controlled
  result**? *Lean: exclude from the set (a hidden link is "not a match"), matching row-deny precedent — but
  this is a real semantics decision, not a footnote.*
- **Q3 — shared vs parallel eval path.** Reuse the nested-groups `pruneFilterNode` / `evaluateFilterNode`
  threading (extend the per-leaf evaluator to receive the record's permission-filtered summaries) vs a
  separate link-only filter pass. *Lean: extend the existing per-leaf evaluator so link conditions compose
  inside nested AND/OR groups for free — but verify it doesn't bloat the pure eval's signature.*
- **Q4 — operators + FE.** Which operators for link/lookup: `contains` / `is` / `isAnyOf` / `isEmpty` over
  display values? And the FE operator menu + value control (free-text vs a linked-record picker). *Lean:
  start with `contains`/`is`/`isEmpty` over display (free-text), defer a linked-record picker.*

## 3. Locked principles (independent of the open questions)

- **Permission: filter-at-materialization.** Denied linked records (`loadDeniedRecordIds(foreignSheetId)`)
  are excluded from the comparison set **before** the eval sees them — never read-raw-then-mask. Reuses the
  exact discipline from dashboard chart-data + nested-filter redaction.
- **No silent wrong match.** Whatever Q2 resolves to, the rule is: a hidden link never produces a match a
  full-permission user wouldn't see, and never leaks the hidden display string.
- **Compose with nested groups.** A link condition must be a normal leaf inside the nested AND/OR tree
  (Q3) — not a special top-level-only case.
- **Bounded.** Reuses the existing per-record summary materialization (already paginated/bounded); no new
  unbounded scan. Cross-base links out of scope at lock time.

## 4. Gated TODO checklist
> 🔒 blocked · ⬜ ready · ✅ done

- ✅ **G0 — this design-lock** (crux + 4 open questions + locked principles).
- 🔒 **G1 — resolve Q1–Q4** at review (owner decision).
- 🔒 **Slice — link filter eval** (permission-filtered display materialization → per-leaf eval threading →
  operators → real-DB permission goldens: denied-link excluded, hidden-display non-leak, composes in nested
  group). *Opt-in after G1.*
- 🔒 **Slice — lookup filter eval** (same, over the materialized lookup value). *After link slice.*
- 🔒 **FE — link/lookup operator menu + value control.** *With/after the eval slice.*

## 5. Non-goals
- No cross-base link filtering at lock time.
- No linked-record picker UI in the first slice (free-text over display first).
- Own principles only; standard nomenclature, no external product names.
